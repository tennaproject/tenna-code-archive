import { fetchShardEntry } from "./archive-client";
import { failureMessage, setPageTitle } from "./ui";

async function load(): Promise<void> {
  const code = document.querySelector<HTMLElement>("#source-code");
  if (code === null) throw new Error("Missing #source-code");
  const parameters = new URLSearchParams(location.search);
  const name = parameters.get("name");
  if (name !== null) {
    const filename = name.endsWith(".gml") ? name : `${name}.gml`;
    setPageTitle(filename, "Raw source");
  }
  try {
    code.textContent = await fetchShardEntry<string>(
      "/data/sources",
      "sources",
      parameters.get("hash") ?? "",
    );
  } catch (error) {
    code.textContent = failureMessage(
      error,
      "Unable to load this source file. Check your connection and try again.",
    );
  } finally {
    code.setAttribute("aria-busy", "false");
  }
}

void load();
