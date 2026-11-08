-- Form field labels hold the question itself, not a short caption: the staff
-- application uses them for multi-sentence scenario prompts. VARCHAR(255) cut
-- those questions off mid-word on the public form. Widen to TEXT so a long
-- question is stored whole; helpText/description were already TEXT.
ALTER TABLE `formFields`
  MODIFY COLUMN `label` TEXT NOT NULL;
