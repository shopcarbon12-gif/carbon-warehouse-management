# CarbonGradingAI — training the app's own point model (Phase 3)

Until this model exists, the WMS's AI assist (`GRADING_APP_AI_MODEL`, default `gpt-6-astra`) places
the seam points — about 5–7¢ a scan. Every scan saved from the app is a training example: the photo is
squared up at a known scale, and each point of measure is stored as its end points *as the operator
left them*, with what the outline and the AI had proposed (`moved` = corrected by hand).

## 1. Export
```bash
# prod data through the tunnel (see reference_prod_db_access in memory / AGENT_CREDENTIALS.md)
npx tsx scripts/export-grading-training-set.ts --out ~/grading-dataset --status approved,saved
```
`annotations.json` → `items[]`: `file`, `width`, `height`, `profile`, `pxPerCm`, `points{key:{pts:[[x,y],…],source,moved}}`.
Only depth-sensor scans are exported (test-phone scans are excluded).

## 2. Train (when there are enough scans — the plan's target is ~2,000 confirmed, ≥150 per garment type)
- One keypoint model for all types: input the squared-up photo resized to 512 px on the long side
  (keep the scale factor), output one heatmap per end point name (`chest.a`, `chest.b`, `sleeveL.a`, …;
  ~60 channels across all profiles; a profile only reads its own channels).
- Apache-2.0 tooling only (plan decision): e.g. TensorFlow/Keras with a MobileNetV3 backbone and a
  small upsampling head, exported to TFLite (LiteRT) for the phone; or PyTorch + an Apache-licensed
  pose head, exported through ONNX → TFLite. Weight `moved` examples ×3.
- Hold out the owner's tape-measured garments (T-shirt UPC 1125451 M, jeans 1125008 size 29, and any
  added later) — never train on them.

## 3. Pass marks before switching the AI off
On the held-out tape garments, through the full phone pipeline (depth scale, cut-out, model):
widths and lengths within **1 cm** of the tape; inseam and front rise within **1.5 cm**; the same
garment scanned 3 times, moved between scans, agrees within **0.5 cm**.

## 4. Ship
Add the `.tflite` to the app (`app/src/main/assets/`) with LiteRT, run it after the cut-out in
`measure/Pipeline.kt`, and put its points in as `source = "model"` before the outline. Release an
update; when it passes on the phone, set `GRADING_APP_AI_MODEL=off` on the WMS — scans then cost $0.
