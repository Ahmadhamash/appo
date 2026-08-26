ALTER TABLE "predictions" DROP CONSTRAINT "predictions_outcome";

ALTER TABLE "predictions"
ADD CONSTRAINT "predictions_outcome" CHECK (
  (
    "status" = 'GENERATED'
    AND "estimate" IS NOT NULL
    AND "refusal_reason" IS NULL
    AND (
      (
        "capability" = 'NO_SHOW'
        AND (
          ("lower_bound" IS NULL AND "upper_bound" IS NULL)
          OR (
            "lower_bound" IS NOT NULL
            AND "upper_bound" IS NOT NULL
            AND "lower_bound" <= "estimate"
            AND "estimate" <= "upper_bound"
          )
        )
      )
      OR (
        "capability" <> 'NO_SHOW'
        AND "lower_bound" IS NOT NULL
        AND "upper_bound" IS NOT NULL
        AND "lower_bound" <= "estimate"
        AND "estimate" <= "upper_bound"
      )
    )
  )
  OR (
    "status" = 'REFUSED'
    AND "estimate" IS NULL
    AND "lower_bound" IS NULL
    AND "upper_bound" IS NULL
    AND "refusal_reason" IS NOT NULL
  )
);
