interface PreviewContentTarget {
  dataset: {
    loading?: string;
    loaded?: string;
  };
  innerHTML: string;
  textContent: string | null;
}

export type PreviewLoadResult = "loaded" | "skipped" | "failed";

export async function populatePreview(
  content: PreviewContentTarget,
  loadHtml: () => Promise<string>,
  afterLoad: () => void,
  errorText: (error: unknown) => string,
): Promise<PreviewLoadResult> {
  if (content.dataset.loading !== undefined || content.dataset.loaded !== undefined) {
    return "skipped";
  }
  content.dataset.loading = "true";
  try {
    content.innerHTML = await loadHtml();
    afterLoad();
    content.dataset.loaded = "true";
    return "loaded";
  } catch (error) {
    content.textContent = errorText(error);
    return "failed";
  } finally {
    delete content.dataset.loading;
  }
}
