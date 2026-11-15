-- CarbonWMS Creative — a finished video must not say "Ready to film again — tap Make the video" (that button only
-- exists before filming; the note was left over from an earlier Film it again). Clears that note on finished ones.
UPDATE public.creative_projects SET step_note = NULL
 WHERE status = 'final' AND step_note LIKE 'Ready to film again%';
