"use server";

import { prisma } from "@jormall/db/client";
import { DomainError } from "@jormall/domain/errors";
import { gymAvatarFrames, gymAvatarHairStyles, gymAvatarSkinTones } from "@jormall/domain/gym";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { auth } from "../../../server/auth";
import { gymRepository } from "../../../server/identity";
import { requireSession } from "../../../server/session";

const localeSchema = z.enum(["en", "ar"]);
const uuidSchema = z.uuid();

function value(formData: FormData, name: string): unknown {
  return formData.get(name);
}

function localeFrom(formData: FormData): "en" | "ar" {
  return localeSchema.catch("en").parse(value(formData, "locale"));
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

function destination(path: string, key: "error" | "notice", code: string): string {
  return `${path}?${key}=${encodeURIComponent(code)}`;
}

function optionalNumber(formData: FormData, name: string): unknown {
  const raw = value(formData, name);
  return raw === "" || raw === null ? undefined : raw;
}

export async function acceptTraineeInvitationAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const token = z.string().min(20).max(200).safeParse(value(formData, "token"));
  if (!token.success) redirect(destination(`/${locale}/login`, "error", "INVITATION_INVALID"));
  const session = await requireSession(locale);
  try {
    await gymRepository.acceptPortalInvitation(session.user.id, session.user.email, token.data);
    await prisma.session.update({
      data: {
        activeMembershipId: null,
        activeOrganizationId: null,
        activeSupportAccessId: null,
      },
      where: { id: session.session.id },
    });
  } catch (error) {
    redirect(
      destination(`/${locale}/trainee-invitations/${token.data}`, "error", errorCode(error)),
    );
  }
  redirect(destination(`/${locale}/trainee`, "notice", "GYM_PORTAL_INVITATION_ACCEPTED"));
}

export async function registerTraineeInvitationAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(160),
      password: z.string().min(12).max(128),
      token: z.string().min(20).max(200),
    })
    .safeParse({
      name: value(formData, "name"),
      password: value(formData, "password"),
      token: value(formData, "token"),
    });
  if (!parsed.success) redirect(destination(`/${locale}/login`, "error", "VALIDATION_FAILED"));
  let registeredUserId: string | undefined;
  try {
    const preview = await gymRepository.previewPortalInvitation(parsed.data.token);
    const existing = await prisma.user.findUnique({
      select: { id: true },
      where: { email: preview.email },
    });
    if (existing) {
      throw new DomainError({
        code: "CONFLICT",
        message: "Sign in with the invited email address.",
      });
    }
    const registration = await auth.api.signUpEmail({
      body: { email: preview.email, name: parsed.data.name, password: parsed.data.password },
      headers: await headers(),
    });
    registeredUserId = registration.user.id;
    await gymRepository.acceptPortalInvitation(
      registration.user.id,
      registration.user.email,
      parsed.data.token,
    );
    if (!registration.token) {
      throw new DomainError({ code: "INTERNAL_ERROR", message: "Session was not created." });
    }
    await prisma.session.updateMany({
      data: { activeMembershipId: null, activeOrganizationId: null, activeSupportAccessId: null },
      where: { token: registration.token, userId: registration.user.id },
    });
  } catch (error) {
    if (registeredUserId) {
      await prisma.user.deleteMany({
        where: { id: registeredUserId, memberships: { none: {} }, gymPortalAccess: null },
      });
    }
    redirect(
      destination(`/${locale}/trainee-invitations/${parsed.data.token}`, "error", errorCode(error)),
    );
  }
  redirect(destination(`/${locale}/trainee`, "notice", "GYM_PORTAL_INVITATION_ACCEPTED"));
}

export async function recordOwnWorkoutAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      actualReps: z.coerce.number().int().min(1).max(500),
      actualSets: z.coerce.number().int().min(1).max(30),
      actualWeightKg: z.preprocess(
        (input) => (input === undefined ? undefined : input),
        z.coerce.number().min(0).max(1000).optional(),
      ),
      perceivedEffort: z.preprocess(
        (input) => (input === undefined ? undefined : input),
        z.coerce.number().int().min(1).max(10).optional(),
      ),
      workoutExerciseId: uuidSchema,
    })
    .safeParse({
      actualReps: value(formData, "actualReps"),
      actualSets: value(formData, "actualSets"),
      actualWeightKg: optionalNumber(formData, "actualWeightKg"),
      perceivedEffort: optionalNumber(formData, "perceivedEffort"),
      workoutExerciseId: value(formData, "workoutExerciseId"),
    });
  const path = `/${locale}/trainee`;
  if (!parsed.success) redirect(destination(path, "error", "VALIDATION_FAILED"));
  try {
    const session = await requireSession(locale);
    await gymRepository.recordOwnWorkout(session.user.id, parsed.data);
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_WORKOUT_RECORDED"));
}

export async function recordOwnProgressAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      bodyFatPercent: z.preprocess(
        (input) => (input === undefined ? undefined : input),
        z.coerce.number().min(1).max(80).optional(),
      ),
      bodyWeightKg: z.coerce.number().min(20).max(400),
      waistCm: z.preprocess(
        (input) => (input === undefined ? undefined : input),
        z.coerce.number().min(20).max(300).optional(),
      ),
    })
    .safeParse({
      bodyFatPercent: optionalNumber(formData, "bodyFatPercent"),
      bodyWeightKg: value(formData, "bodyWeightKg"),
      waistCm: optionalNumber(formData, "waistCm"),
    });
  const path = `/${locale}/trainee`;
  if (!parsed.success) redirect(destination(path, "error", "VALIDATION_FAILED"));
  try {
    const session = await requireSession(locale);
    await gymRepository.recordOwnProgress(session.user.id, parsed.data);
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_PROGRESS_RECORDED"));
}

export async function updateOwnAvatarAction(formData: FormData): Promise<never> {
  const locale = localeFrom(formData);
  const parsed = z
    .object({
      frame: z.enum(gymAvatarFrames),
      hairStyle: z.enum(gymAvatarHairStyles),
      shirtColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
      skinTone: z.enum(gymAvatarSkinTones),
    })
    .safeParse({
      frame: value(formData, "frame"),
      hairStyle: value(formData, "hairStyle"),
      shirtColor: value(formData, "shirtColor"),
      skinTone: value(formData, "skinTone"),
    });
  const path = `/${locale}/trainee`;
  if (!parsed.success) redirect(destination(path, "error", "VALIDATION_FAILED"));
  try {
    const session = await requireSession(locale);
    await gymRepository.updateOwnAvatar(session.user.id, parsed.data);
    revalidatePath(path);
  } catch (error) {
    redirect(destination(path, "error", errorCode(error)));
  }
  redirect(destination(path, "notice", "GYM_AVATAR_UPDATED"));
}
