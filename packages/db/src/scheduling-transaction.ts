import { DomainError } from "@jormall/domain/errors";
import { localDateTimePartsForInstant, localDateTimeToUtc } from "@jormall/domain/timezone";

import {
  AppointmentHistoryType,
  AttributionSource,
  Prisma,
  type AppointmentSource,
  type AppointmentStatus,
} from "./generated/prisma/client";
import type { TenantTransaction } from "./tenant-context";

type SchedulingRule = Readonly<{
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  endMinuteLocal: number;
  startMinuteLocal: number;
  weekday: string;
}>;

function attributionForAppointment(source: AppointmentSource): AttributionSource {
  if (source === "PUBLIC_BOOKING") return AttributionSource.PUBLIC_BOOKING;
  if (source === "WEBSITE_AI") return AttributionSource.WEBSITE_CHATBOT;
  if (source === "WHATSAPP_AI") return AttributionSource.WHATSAPP_AI;
  if (source === "VOICE_AI") return AttributionSource.VOICE_AI;
  return AttributionSource.STAFF_MANUAL;
}

export type PreparedBooking = Readonly<{
  branchId: string;
  bufferAfterMins: number;
  bufferBeforeMins: number;
  endsAt: Date;
  organizationId: string;
  providerId: string;
  reservationEndsAt: Date;
  reservationStartsAt: Date;
  serviceId: string;
  startsAt: Date;
  timezone: string;
}>;

function databaseCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

export function isSchedulingConstraintConflict(error: unknown): boolean {
  return ["P2002", "P2010", "23P01"].includes(databaseCode(error) ?? "");
}

export function schedulingConflict(message: string): DomainError {
  return new DomainError({
    code: "CONFLICT",
    message,
    metadata: { conflict: "SLOT_UNAVAILABLE" },
    retryable: true,
  });
}

function localDate(parts: Readonly<{ day: number; month: number; year: number }>): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function weekdayForLocalDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][
      date.getUTCDay()
    ] ?? "SUNDAY"
  );
}

function dateValue(value: Date | null): string | undefined {
  return value?.toISOString().slice(0, 10);
}

function ruleCovers(
  rule: SchedulingRule,
  date: string,
  weekday: string,
  startMinute: number,
  endMinute: number,
): boolean {
  const effectiveFrom = dateValue(rule.effectiveFrom);
  const effectiveUntil = dateValue(rule.effectiveUntil);
  return (
    rule.weekday === weekday &&
    (!effectiveFrom || effectiveFrom <= date) &&
    (!effectiveUntil || effectiveUntil >= date) &&
    rule.startMinuteLocal <= startMinute &&
    rule.endMinuteLocal >= endMinute
  );
}

function localReservationWindow(booking: PreparedBooking): Readonly<{
  date: string;
  endMinute: number;
  startMinute: number;
  weekday: string;
}> {
  const start = localDateTimePartsForInstant(booking.reservationStartsAt, booking.timezone);
  const end = localDateTimePartsForInstant(booking.reservationEndsAt, booking.timezone);
  const startDate = localDate(start);
  if (startDate !== localDate(end)) {
    throw schedulingConflict("The appointment and its buffers must fit within one branch day.");
  }
  return {
    date: startDate,
    endMinute: end.hour * 60 + end.minute,
    startMinute: start.hour * 60 + start.minute,
    weekday: weekdayForLocalDate(startDate),
  };
}

export async function prepareBooking(
  transaction: TenantTransaction,
  input: Readonly<{
    branchId: string;
    organizationId: string;
    providerId: string;
    serviceId: string;
    startsAtLocal: string;
  }>,
): Promise<PreparedBooking> {
  const [branch, serviceBranch, provider] = await Promise.all([
    transaction.branch.findFirst({
      select: { id: true, timezone: true },
      where: { id: input.branchId, isActive: true, organizationId: input.organizationId },
    }),
    transaction.serviceBranch.findFirst({
      include: { service: { select: { defaultDurationMins: true, isActive: true } } },
      where: {
        branchId: input.branchId,
        isEnabled: true,
        organizationId: input.organizationId,
        serviceId: input.serviceId,
      },
    }),
    transaction.staffProfile.findFirst({
      select: { id: true },
      where: {
        branchAssignments: { some: { branchId: input.branchId } },
        id: input.providerId,
        isBookable: true,
        organizationId: input.organizationId,
        services: { some: { isEnabled: true, serviceId: input.serviceId } },
      },
    }),
  ]);
  if (!branch || !serviceBranch || !serviceBranch.service.isActive || !provider) {
    throw new DomainError({ code: "NOT_FOUND", message: "Appointment references are invalid." });
  }
  const durationMins = serviceBranch.durationMins ?? serviceBranch.service.defaultDurationMins;
  if (durationMins <= 0) {
    throw new DomainError({ code: "VALIDATION_FAILED", message: "Service duration is invalid." });
  }
  const startsAt = localDateTimeToUtc(input.startsAtLocal, branch.timezone);
  const endsAt = new Date(startsAt.getTime() + durationMins * 60_000);
  return {
    branchId: input.branchId,
    bufferAfterMins: serviceBranch.bufferAfterMins,
    bufferBeforeMins: serviceBranch.bufferBeforeMins,
    endsAt,
    organizationId: input.organizationId,
    providerId: input.providerId,
    reservationEndsAt: new Date(endsAt.getTime() + serviceBranch.bufferAfterMins * 60_000),
    reservationStartsAt: new Date(startsAt.getTime() - serviceBranch.bufferBeforeMins * 60_000),
    serviceId: input.serviceId,
    startsAt,
    timezone: branch.timezone,
  };
}

export async function assertBookableSchedule(
  transaction: TenantTransaction,
  booking: PreparedBooking,
  excludeAppointmentId?: string,
): Promise<void> {
  await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "staff_profiles"
    WHERE "organization_id" = ${booking.organizationId}::uuid
      AND "id" = ${booking.providerId}::uuid
    FOR UPDATE
  `);
  const window = localReservationWindow(booking);
  const [branchHours, availabilityRules, timeOff, existingReservation] = await Promise.all([
    transaction.branchHoursRule.findMany({
      where: { branchId: booking.branchId, organizationId: booking.organizationId },
    }),
    transaction.availabilityRule.findMany({
      where: {
        OR: [{ branchId: booking.branchId }, { branchId: null }],
        organizationId: booking.organizationId,
        staffProfileId: booking.providerId,
      },
    }),
    transaction.timeOff.findFirst({
      where: {
        OR: [{ branchId: booking.branchId }, { branchId: null }],
        endsAt: { gt: booking.reservationStartsAt },
        organizationId: booking.organizationId,
        staffProfileId: booking.providerId,
        startsAt: { lt: booking.reservationEndsAt },
      },
    }),
    transaction.appointmentStaffReservation.findFirst({
      where: {
        ...(excludeAppointmentId ? { appointmentId: { not: excludeAppointmentId } } : {}),
        endsAt: { gt: booking.reservationStartsAt },
        organizationId: booking.organizationId,
        providerId: booking.providerId,
        startsAt: { lt: booking.reservationEndsAt },
      },
    }),
  ]);
  if (
    !branchHours.some((rule) =>
      ruleCovers(rule, window.date, window.weekday, window.startMinute, window.endMinute),
    )
  ) {
    throw schedulingConflict("The requested time is outside branch opening hours.");
  }
  if (
    !availabilityRules.some((rule) =>
      ruleCovers(rule, window.date, window.weekday, window.startMinute, window.endMinute),
    )
  ) {
    throw schedulingConflict("The provider is not working at the requested time.");
  }
  if (timeOff) {
    throw schedulingConflict("The provider has time off during the requested time.");
  }
  if (existingReservation) {
    throw schedulingConflict("The provider is already booked during the requested time or buffer.");
  }
}

export async function reserveRequiredResources(
  transaction: TenantTransaction,
  booking: PreparedBooking,
  appointmentId: string,
  excludeAppointmentId?: string,
): Promise<void> {
  const requirements = await transaction.serviceResourceRequirement.findMany({
    include: { resourceGroup: { select: { nameEn: true } } },
    orderBy: { resourceGroupId: "asc" },
    where: {
      branchId: booking.branchId,
      organizationId: booking.organizationId,
      serviceId: booking.serviceId,
    },
  });
  const window = localReservationWindow(booking);
  for (const requirement of requirements) {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "resources"
      WHERE "organization_id" = ${booking.organizationId}::uuid
        AND "branch_id" = ${booking.branchId}::uuid
        AND "group_id" = ${requirement.resourceGroupId}::uuid
        AND "status" = 'ACTIVE'::"ResourceStatus"
      ORDER BY "id"
      FOR UPDATE
    `);
    const resourceIds = locked.map(({ id }) => id);
    if (resourceIds.length < requirement.quantity) {
      throw schedulingConflict(
        `Not enough active ${requirement.resourceGroup.nameEn} resources are configured.`,
      );
    }
    const resources = await transaction.resource.findMany({
      include: { availabilityRules: true },
      orderBy: { id: "asc" },
      where: { id: { in: resourceIds }, organizationId: booking.organizationId },
    });
    const overlapping = await transaction.appointmentResource.findMany({
      select: { resourceId: true },
      where: {
        ...(excludeAppointmentId ? { appointmentId: { not: excludeAppointmentId } } : {}),
        endsAt: { gt: booking.reservationStartsAt },
        organizationId: booking.organizationId,
        resourceId: { in: resourceIds },
        startsAt: { lt: booking.reservationEndsAt },
      },
    });
    const unavailable = new Set(overlapping.map(({ resourceId }) => resourceId));
    const selected = resources
      .filter((resource) => {
        if (unavailable.has(resource.id)) return false;
        return (
          resource.availabilityRules.length === 0 ||
          resource.availabilityRules.some((rule) =>
            ruleCovers(rule, window.date, window.weekday, window.startMinute, window.endMinute),
          )
        );
      })
      .slice(0, requirement.quantity);
    if (selected.length < requirement.quantity) {
      throw schedulingConflict(
        `${requirement.resourceGroup.nameEn} capacity is no longer available for this time.`,
      );
    }
    await transaction.appointmentResource.createMany({
      data: selected.map(({ id }) => ({
        appointmentId,
        endsAt: booking.reservationEndsAt,
        organizationId: booking.organizationId,
        resourceGroupId: requirement.resourceGroupId,
        resourceId: id,
        startsAt: booking.reservationStartsAt,
      })),
    });
  }
}

export async function createAppointmentRows(
  transaction: TenantTransaction,
  input: Readonly<{
    actorUserId: string;
    appointmentId: string;
    branchId: string;
    customerId: string;
    organizationId: string;
    providerId: string;
    serviceId: string;
    source: AppointmentSource;
    startsAtLocal: string;
    status: AppointmentStatus;
  }>,
) {
  const customer = await transaction.customer.findFirst({
    select: { id: true },
    where: { id: input.customerId, isArchived: false, organizationId: input.organizationId },
  });
  if (!customer) {
    throw new DomainError({ code: "NOT_FOUND", message: "Appointment customer is invalid." });
  }
  const booking = await prepareBooking(transaction, input);
  await assertBookableSchedule(transaction, booking);
  try {
    const appointment = await transaction.appointment.create({
      data: {
        branchId: booking.branchId,
        customerId: input.customerId,
        endsAt: booking.endsAt,
        id: input.appointmentId,
        organizationId: booking.organizationId,
        providerId: booking.providerId,
        serviceId: booking.serviceId,
        source: input.source,
        startsAt: booking.startsAt,
        status: input.status,
        timezone: booking.timezone,
        history: {
          create: {
            actorUserId: input.actorUserId,
            endsAt: booking.endsAt,
            eventType: AppointmentHistoryType.CREATED,
            source: input.source,
            startsAt: booking.startsAt,
            toStatus: input.status,
            version: 1,
          },
        },
        participants: {
          create: [
            { customerId: input.customerId, participantType: "CUSTOMER" },
            { participantType: "PROVIDER", staffProfileId: booking.providerId },
          ],
        },
        reservation: {
          create: {
            endsAt: booking.reservationEndsAt,
            providerId: booking.providerId,
            startsAt: booking.reservationStartsAt,
          },
        },
      },
    });
    await reserveRequiredResources(transaction, booking, appointment.id);
    await transaction.attributionEvent.create({
      data: {
        appointmentId: appointment.id,
        customerId: input.customerId,
        occurredAt: appointment.createdAt,
        organizationId: booking.organizationId,
        source: attributionForAppointment(input.source),
        sourceDetail: input.source === "IMPORT" ? "CSV import" : null,
      },
    });
    return appointment;
  } catch (error) {
    if (isSchedulingConstraintConflict(error)) {
      throw schedulingConflict("The selected provider or resource is no longer available.");
    }
    throw error;
  }
}

export async function rescheduleAppointmentRows(
  transaction: TenantTransaction,
  input: Readonly<{
    actorUserId: string;
    appointmentId: string;
    expectedVersion: number;
    organizationId: string;
    startsAtLocal: string;
  }>,
) {
  const current = await transaction.appointment.findFirst({
    where: { id: input.appointmentId, organizationId: input.organizationId },
  });
  if (!current) {
    throw new DomainError({ code: "NOT_FOUND", message: "Appointment not found." });
  }
  const booking = await prepareBooking(transaction, {
    branchId: current.branchId,
    organizationId: input.organizationId,
    providerId: current.providerId,
    serviceId: current.serviceId,
    startsAtLocal: input.startsAtLocal,
  });
  await assertBookableSchedule(transaction, booking, current.id);
  const changed = await transaction.appointment.updateMany({
    data: { endsAt: booking.endsAt, startsAt: booking.startsAt, version: { increment: 1 } },
    where: {
      id: current.id,
      organizationId: input.organizationId,
      version: input.expectedVersion,
    },
  });
  if (changed.count !== 1) {
    throw schedulingConflict("Appointment changed by another user. Refresh and try again.");
  }
  try {
    await transaction.appointmentStaffReservation.update({
      data: { endsAt: booking.reservationEndsAt, startsAt: booking.reservationStartsAt },
      where: { appointmentId: current.id },
    });
    await transaction.appointmentResource.deleteMany({
      where: { appointmentId: current.id, organizationId: input.organizationId },
    });
    await reserveRequiredResources(transaction, booking, current.id, current.id);
  } catch (error) {
    if (isSchedulingConstraintConflict(error)) {
      throw schedulingConflict("The selected provider or resource is no longer available.");
    }
    throw error;
  }
  await transaction.appointmentStatusHistory.create({
    data: {
      actorUserId: input.actorUserId,
      appointmentId: current.id,
      endsAt: booking.endsAt,
      eventType: AppointmentHistoryType.RESCHEDULED,
      fromStatus: current.status,
      organizationId: input.organizationId,
      source: current.source,
      startsAt: booking.startsAt,
      toStatus: current.status,
      version: input.expectedVersion + 1,
    },
  });
  return transaction.appointment.findFirstOrThrow({
    where: { id: current.id, organizationId: input.organizationId },
  });
}
