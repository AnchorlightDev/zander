-- Per-field settings for the form builder.
--
-- Several field types need their own knobs: how many images an upload field
-- accepts, the end points and labels of a linear scale, and (any type) the
-- condition under which the field is shown at all. One JSON column rather than
-- a column per setting -- these are read back whole, for one field at a time,
-- by code that already has to know the field's type to interpret them, and a
-- new setting must not mean a new migration every time.
--
-- Shape is validated and clamped in lib/formFields.js (normaliseFieldConfig),
-- not here: unknown keys are dropped and out-of-range values pulled back into
-- range, so a hand-posted config cannot widen a limit.
--
--   images  { maxImages: 10 }
--   scale   { scaleMin: 1, scaleMax: 10, scaleMinLabel: "Poor", scaleMaxLabel: "Excellent" }
--   any     { showIf: { fieldKey: "applying_for", equals: ["moderator"] } }
--
-- NULL means "no settings", which is every field created before this ran.
ALTER TABLE `formFields`
  ADD COLUMN `config` JSON NULL AFTER `maxLength`;
