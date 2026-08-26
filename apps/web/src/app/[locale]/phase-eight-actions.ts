"use server";

import {
  getPredictiveRepository,
  type TenantAccessSelection,
} from "@jormall/db/predictive-repository";
import { DomainError } from "@jormall/domain/errors";
import { predictionFeedbackTypes, predictiveCapabilities } from "@jormall/domain/predictive";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import type { JorMallSession } from "../../server/auth";
import { requireTenantPermission } from "../../server/identity";
import { requireSession } from "../../server/session";

const localeSchema = z.enum(["en", "ar"]);
const uuidSchema = z.uuid();
const jobTypes = ["DATA_AUDIT", "FEATURE_COMPUTE", "GENERATE", "BACKTEST", "DRIFT"] as const;

function value(formData: FormData, name: string): unknown {
  return formData.get(name);
}

function optionalValue(formData: FormData, name: string): unknown {
  const entry = value(formData, name);
  return entry === "" || entry === null ? undefined : entry;
}

function localeFrom(formData: FormData): "ar" | "en" {
  return localeSchema.catch("en").parse(value(formData, "locale"));
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

function destination(locale: string, key: "error" | "notice", code: string): string {
  return `/${locale}/dashboard/predictions?${key}=${encodeURIComponent(code)}`;
}

function selectionFromSession(session: JorMallSession): TenantAccessSelection {
  return {
    ...(session.session.activeMembershipId
      ? { activeMembershipId: session.session.activeMembershipId }
      : {}),
    ...(session.session.activeOrganizationId
      ? { activeOrganizationId: session.session.activeOrganizationId }
      : {}),
    ...(session.session.activeSupportAccessId
      ? { activeSupportAccessId: session.session.activeSupportAccessId }
      : {}),
  };
}

export async function requestPredictiveJobAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      appointmentId: uuidSchema.optional(),
      branchId: uuidSchema.optional(),
      capability: z.enum(predictiveCapabilities),
      endsOn: z.iso.date().optional(),
      idempotencyKey: z.string().trim().min(16).max(160),
      jobType: z.enum(jobTypes),
      serviceId: uuidSchema.optional(),
      startsOn: z.iso.date().optional(),
    })
    .refine(
      ({ endsOn, startsOn }) =>
        (!endsOn && !startsOn) || Boolean(endsOn && startsOn && endsOn >= startsOn),
      { message: "The optional local-date range is incomplete or invalid." },
    )
    .safeParse({
      appointmentId: optionalValue(formData, "appointmentId"),
      branchId: optionalValue(formData, "branchId"),
      capability: value(formData, "capability"),
      endsOn: optionalValue(formData, "endsOn"),
      idempotencyKey: value(formData, "idempotencyKey"),
      jobType: value(formData, "jobType"),
      serviceId: optionalValue(formData, "serviceId"),
      startsOn: optionalValue(formData, "startsOn"),
    });
  if (!parsed.success) {
    redirect(destination(locale, "error", "VALIDATION_FAILED"));
  }
  try {
    await requireTenantPermission(
      locale,
      "predictions.run",
      parsed.data.branchId ? { branchId: parsed.data.branchId } : {},
    );
    const session = await requireSession(locale);
    await getPredictiveRepository().requestJob(selectionFromSession(session), {
      actorUserId: session.user.id,
      capability: parsed.data.capability,
      idempotencyKey: parsed.data.idempotencyKey,
      jobType: parsed.data.jobType,
      ...(parsed.data.appointmentId ? { appointmentId: parsed.data.appointmentId } : {}),
      ...(parsed.data.branchId ? { branchId: parsed.data.branchId } : {}),
      ...(parsed.data.serviceId ? { serviceId: parsed.data.serviceId } : {}),
      ...(parsed.data.startsOn ? { startsOn: parsed.data.startsOn } : {}),
      ...(parsed.data.endsOn ? { endsOn: parsed.data.endsOn } : {}),
    });
    revalidatePath(`/${locale}/dashboard/predictions`);
  } catch (error) {
    redirect(destination(locale, "error", errorCode(error)));
  }
  redirect(destination(locale, "notice", "PREDICTIVE_JOB_REQUESTED"));
}

export async function updatePredictiveCapabilityAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      capability: z.enum(predictiveCapabilities),
      enabled: z.boolean(),
      expectedVersion: z.coerce.number().int().positive(),
    })
    .safeParse({
      capability: value(formData, "capability"),
      enabled: z.literal("on").safeParse(value(formData, "enabled")).success,
      expectedVersion: value(formData, "expectedVersion"),
    });
  if (!parsed.success) {
    redirect(destination(locale, "error", "VALIDATION_FAILED"));
  }
  try {
    await requireTenantPermission(locale, "predictions.configure");
    const session = await requireSession(locale);
    await getPredictiveRepository().updateCapability(selectionFromSession(session), {
      actorUserId: session.user.id,
      capability: parsed.data.capability,
      enabled: parsed.data.enabled,
      expectedVersion: parsed.data.expectedVersion,
    });
    revalidatePath(`/${locale}/dashboard/predictions`);
  } catch (error) {
    redirect(destination(locale, "error", errorCode(error)));
  }
  redirect(destination(locale, "notice", "PREDICTIVE_CAPABILITY_UPDATED"));
}

export async function recordPredictionFeedbackAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      comment: z.string().trim().max(500).optional(),
      feedbackType: z.enum(predictionFeedbackTypes),
      predictionId: uuidSchema,
    })
    .safeParse({
      comment: optionalValue(formData, "comment"),
      feedbackType: value(formData, "feedbackType"),
      predictionId: value(formData, "predictionId"),
    });
  if (!parsed.success) {
    redirect(destination(locale, "error", "VALIDATION_FAILED"));
  }
  try {
    const session = await requireSession(locale);
    await getPredictiveRepository().recordFeedback(selectionFromSession(session), {
      actorUserId: session.user.id,
      feedbackType: parsed.data.feedbackType,
      predictionId: parsed.data.predictionId,
      ...(parsed.data.comment ? { comment: parsed.data.comment } : {}),
    });
    revalidatePath(`/${locale}/dashboard/predictions`);
  } catch (error) {
    redirect(destination(locale, "error", errorCode(error)));
  }
  redirect(destination(locale, "notice", "PREDICTION_FEEDBACK_RECORDED"));
}
