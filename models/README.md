The website's multilingual image classifier can use these local files:

- `airwrite_multilingual.keras`
- `airwrite_multilingual.labels.json`
- `airwrite_multilingual.preprocessing.json`

Keep the label list in the checkpoint's original class order. The website validates all 74 labels, the `28 × 28 × 1` input contract, the `[0, 1]` grayscale preprocessing, and the class-group index ranges before enabling prediction. Without a local checkpoint, the website downloads the same files from `AIRWRITE_IMAGE_HF_REPO`. The desktop application keeps its separate `.keras`/SVM model-selection workflow.

