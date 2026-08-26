CREATE TYPE "BusinessSector" AS ENUM ('GYM', 'CLINIC', 'BEAUTY_CENTER');
CREATE TYPE "GymGoal" AS ENUM ('WEIGHT_LOSS', 'MUSCLE_GAIN', 'FITNESS', 'MAINTENANCE');
CREATE TYPE "GymExperienceLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED');
CREATE TYPE "GymPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED');

ALTER TABLE "organization_settings"
  ADD COLUMN "business_sector" "BusinessSector";

CREATE TABLE "gym_trainee_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "trainer_staff_profile_id" UUID,
  "goal" "GymGoal" NOT NULL,
  "experience_level" "GymExperienceLevel" NOT NULL DEFAULT 'BEGINNER',
  "height_cm" DECIMAL(5,2),
  "starting_weight_kg" DECIMAL(6,2),
  "target_weight_kg" DECIMAL(6,2),
  "monthly_food_budget_minor" INTEGER,
  "currency" CHAR(3) NOT NULL DEFAULT 'JOD',
  "notes" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gym_trainee_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gym_trainee_profiles_metrics" CHECK (
    ("height_cm" IS NULL OR "height_cm" BETWEEN 80 AND 250) AND
    ("starting_weight_kg" IS NULL OR "starting_weight_kg" BETWEEN 20 AND 400) AND
    ("target_weight_kg" IS NULL OR "target_weight_kg" BETWEEN 20 AND 400) AND
    ("monthly_food_budget_minor" IS NULL OR "monthly_food_budget_minor" BETWEEN 0 AND 100000000) AND
    "version" > 0
  )
);

CREATE TABLE "gym_workout_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "trainee_profile_id" UUID NOT NULL,
  "title_ar" VARCHAR(160) NOT NULL,
  "title_en" VARCHAR(160) NOT NULL,
  "notes_ar" TEXT,
  "notes_en" TEXT,
  "starts_on" DATE NOT NULL,
  "ends_on" DATE,
  "status" "GymPlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gym_workout_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gym_workout_plans_window" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
  CONSTRAINT "gym_workout_plans_version" CHECK ("version" > 0)
);

CREATE TABLE "gym_workout_exercises" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "workout_plan_id" UUID NOT NULL,
  "weekday" "Weekday" NOT NULL,
  "name_ar" VARCHAR(160) NOT NULL,
  "name_en" VARCHAR(160) NOT NULL,
  "sets" INTEGER NOT NULL,
  "reps_min" INTEGER NOT NULL,
  "reps_max" INTEGER NOT NULL,
  "target_weight_kg" DECIMAL(7,2),
  "rest_seconds" INTEGER NOT NULL DEFAULT 60,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "instructions_ar" TEXT,
  "instructions_en" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gym_workout_exercises_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gym_workout_exercises_prescription" CHECK (
    "sets" BETWEEN 1 AND 20 AND
    "reps_min" BETWEEN 1 AND 200 AND
    "reps_max" BETWEEN "reps_min" AND 200 AND
    ("target_weight_kg" IS NULL OR "target_weight_kg" BETWEEN 0 AND 1000) AND
    "rest_seconds" BETWEEN 0 AND 3600 AND
    "sort_order" >= 0
  )
);

CREATE TABLE "gym_workout_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "trainee_profile_id" UUID NOT NULL,
  "workout_exercise_id" UUID NOT NULL,
  "performed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actual_sets" INTEGER NOT NULL,
  "actual_reps" INTEGER NOT NULL,
  "actual_weight_kg" DECIMAL(7,2),
  "perceived_effort" INTEGER,
  "notes" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gym_workout_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gym_workout_logs_performance" CHECK (
    "actual_sets" BETWEEN 1 AND 30 AND
    "actual_reps" BETWEEN 1 AND 500 AND
    ("actual_weight_kg" IS NULL OR "actual_weight_kg" BETWEEN 0 AND 1000) AND
    ("perceived_effort" IS NULL OR "perceived_effort" BETWEEN 1 AND 10) AND
    "version" > 0
  )
);

CREATE TABLE "gym_nutrition_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "trainee_profile_id" UUID NOT NULL,
  "title_ar" VARCHAR(160) NOT NULL,
  "title_en" VARCHAR(160) NOT NULL,
  "goal" "GymGoal" NOT NULL,
  "daily_budget_minor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'JOD',
  "daily_calories" INTEGER NOT NULL,
  "protein_grams" INTEGER NOT NULL,
  "carbohydrates_grams" INTEGER NOT NULL,
  "fat_grams" INTEGER NOT NULL,
  "notes_ar" TEXT,
  "notes_en" TEXT,
  "starts_on" DATE NOT NULL,
  "ends_on" DATE,
  "status" "GymPlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gym_nutrition_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gym_nutrition_plans_targets" CHECK (
    "daily_budget_minor" BETWEEN 0 AND 10000000 AND
    "daily_calories" BETWEEN 500 AND 10000 AND
    "protein_grams" BETWEEN 0 AND 1000 AND
    "carbohydrates_grams" BETWEEN 0 AND 2000 AND
    "fat_grams" BETWEEN 0 AND 1000 AND
    "version" > 0
  ),
  CONSTRAINT "gym_nutrition_plans_window" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on")
);

CREATE TABLE "gym_nutrition_meals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "nutrition_plan_id" UUID NOT NULL,
  "name_ar" VARCHAR(160) NOT NULL,
  "name_en" VARCHAR(160) NOT NULL,
  "timing_label_ar" VARCHAR(120),
  "timing_label_en" VARCHAR(120),
  "estimated_cost_minor" INTEGER NOT NULL,
  "calories" INTEGER NOT NULL,
  "protein_grams" INTEGER NOT NULL,
  "carbohydrates_grams" INTEGER NOT NULL,
  "fat_grams" INTEGER NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gym_nutrition_meals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gym_nutrition_meals_values" CHECK (
    "estimated_cost_minor" BETWEEN 0 AND 10000000 AND
    "calories" BETWEEN 0 AND 10000 AND
    "protein_grams" BETWEEN 0 AND 1000 AND
    "carbohydrates_grams" BETWEEN 0 AND 2000 AND
    "fat_grams" BETWEEN 0 AND 1000 AND
    "sort_order" >= 0
  )
);

CREATE TABLE "gym_progress_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "trainee_profile_id" UUID NOT NULL,
  "measured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "body_weight_kg" DECIMAL(6,2) NOT NULL,
  "body_fat_percent" DECIMAL(5,2),
  "waist_cm" DECIMAL(6,2),
  "notes" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gym_progress_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gym_progress_entries_values" CHECK (
    "body_weight_kg" BETWEEN 20 AND 400 AND
    ("body_fat_percent" IS NULL OR "body_fat_percent" BETWEEN 1 AND 80) AND
    ("waist_cm" IS NULL OR "waist_cm" BETWEEN 20 AND 300)
  )
);

CREATE UNIQUE INDEX "gym_trainee_profiles_organization_id_id_key" ON "gym_trainee_profiles"("organization_id", "id");
CREATE UNIQUE INDEX "gym_trainee_profiles_organization_id_customer_id_key" ON "gym_trainee_profiles"("organization_id", "customer_id");
CREATE INDEX "gym_trainee_profiles_organization_id_trainer_staff_profile_id_idx" ON "gym_trainee_profiles"("organization_id", "trainer_staff_profile_id");
CREATE UNIQUE INDEX "gym_workout_plans_organization_id_id_key" ON "gym_workout_plans"("organization_id", "id");
CREATE INDEX "gym_workout_plans_organization_id_trainee_profile_id_status_starts_on_idx" ON "gym_workout_plans"("organization_id", "trainee_profile_id", "status", "starts_on");
CREATE UNIQUE INDEX "gym_workout_exercises_organization_id_id_key" ON "gym_workout_exercises"("organization_id", "id");
CREATE INDEX "gym_workout_exercises_organization_id_workout_plan_id_weekday_sort_order_idx" ON "gym_workout_exercises"("organization_id", "workout_plan_id", "weekday", "sort_order");
CREATE UNIQUE INDEX "gym_workout_logs_organization_id_id_key" ON "gym_workout_logs"("organization_id", "id");
CREATE INDEX "gym_workout_logs_organization_id_trainee_profile_id_performed_at_idx" ON "gym_workout_logs"("organization_id", "trainee_profile_id", "performed_at");
CREATE INDEX "gym_workout_logs_organization_id_workout_exercise_id_performed_at_idx" ON "gym_workout_logs"("organization_id", "workout_exercise_id", "performed_at");
CREATE UNIQUE INDEX "gym_nutrition_plans_organization_id_id_key" ON "gym_nutrition_plans"("organization_id", "id");
CREATE INDEX "gym_nutrition_plans_organization_id_trainee_profile_id_status_starts_on_idx" ON "gym_nutrition_plans"("organization_id", "trainee_profile_id", "status", "starts_on");
CREATE UNIQUE INDEX "gym_nutrition_meals_organization_id_id_key" ON "gym_nutrition_meals"("organization_id", "id");
CREATE INDEX "gym_nutrition_meals_organization_id_nutrition_plan_id_sort_order_idx" ON "gym_nutrition_meals"("organization_id", "nutrition_plan_id", "sort_order");
CREATE UNIQUE INDEX "gym_progress_entries_organization_id_id_key" ON "gym_progress_entries"("organization_id", "id");
CREATE INDEX "gym_progress_entries_organization_id_trainee_profile_id_measured_at_idx" ON "gym_progress_entries"("organization_id", "trainee_profile_id", "measured_at");

ALTER TABLE "gym_trainee_profiles" ADD CONSTRAINT "gym_trainee_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_trainee_profiles" ADD CONSTRAINT "gym_trainee_profiles_customer_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gym_trainee_profiles" ADD CONSTRAINT "gym_trainee_profiles_trainer_fkey" FOREIGN KEY ("organization_id", "trainer_staff_profile_id") REFERENCES "staff_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gym_workout_plans" ADD CONSTRAINT "gym_workout_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_workout_plans" ADD CONSTRAINT "gym_workout_plans_trainee_fkey" FOREIGN KEY ("organization_id", "trainee_profile_id") REFERENCES "gym_trainee_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_workout_exercises" ADD CONSTRAINT "gym_workout_exercises_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_workout_exercises" ADD CONSTRAINT "gym_workout_exercises_plan_fkey" FOREIGN KEY ("organization_id", "workout_plan_id") REFERENCES "gym_workout_plans"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_workout_logs" ADD CONSTRAINT "gym_workout_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_workout_logs" ADD CONSTRAINT "gym_workout_logs_trainee_fkey" FOREIGN KEY ("organization_id", "trainee_profile_id") REFERENCES "gym_trainee_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_workout_logs" ADD CONSTRAINT "gym_workout_logs_exercise_fkey" FOREIGN KEY ("organization_id", "workout_exercise_id") REFERENCES "gym_workout_exercises"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gym_nutrition_plans" ADD CONSTRAINT "gym_nutrition_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_nutrition_plans" ADD CONSTRAINT "gym_nutrition_plans_trainee_fkey" FOREIGN KEY ("organization_id", "trainee_profile_id") REFERENCES "gym_trainee_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_nutrition_meals" ADD CONSTRAINT "gym_nutrition_meals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_nutrition_meals" ADD CONSTRAINT "gym_nutrition_meals_plan_fkey" FOREIGN KEY ("organization_id", "nutrition_plan_id") REFERENCES "gym_nutrition_plans"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_progress_entries" ADD CONSTRAINT "gym_progress_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gym_progress_entries" ADD CONSTRAINT "gym_progress_entries_trainee_fkey" FOREIGN KEY ("organization_id", "trainee_profile_id") REFERENCES "gym_trainee_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "permissions" ("id", "code", "name_en", "name_ar", "created_at") VALUES
  (gen_random_uuid(), 'gym.trainees.read', 'Read gym trainees', 'عرض متدربي النادي', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'gym.trainees.manage', 'Manage gym trainees', 'إدارة متدربي النادي', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'gym.plans.manage', 'Manage workout and nutrition plans', 'إدارة خطط التمرين والتغذية', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'gym.progress.write', 'Record gym progress', 'تسجيل تقدم المتدرب', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name_en" = EXCLUDED."name_en", "name_ar" = EXCLUDED."name_ar";

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope", "created_at")
SELECT r."organization_id", r."id", p."id", 'ORGANIZATION'::"PermissionScope", CURRENT_TIMESTAMP
FROM "roles" r
JOIN "permissions" p ON p."code" IN ('gym.trainees.read', 'gym.trainees.manage', 'gym.plans.manage', 'gym.progress.write')
WHERE r."system_key" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_MANAGER')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("organization_id", "role_id", "permission_id", "scope", "created_at")
SELECT r."organization_id", r."id", p."id", 'SELF'::"PermissionScope", CURRENT_TIMESTAMP
FROM "roles" r
JOIN "permissions" p ON p."code" IN ('gym.trainees.read', 'gym.plans.manage', 'gym.progress.write')
WHERE r."system_key" = 'PROVIDER'
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON
  "gym_trainee_profiles", "gym_workout_plans", "gym_workout_exercises", "gym_workout_logs",
  "gym_nutrition_plans", "gym_nutrition_meals", "gym_progress_entries"
TO jormall_app;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'gym_trainee_profiles', 'gym_workout_plans', 'gym_workout_exercises', 'gym_workout_logs',
    'gym_nutrition_plans', 'gym_nutrition_meals', 'gym_progress_entries'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = NULLIF(CURRENT_SETTING(''app.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(CURRENT_SETTING(''app.organization_id'', true), '''')::uuid)',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END
$$;
