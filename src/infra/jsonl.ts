export function parseJsonlObjects<T extends object>(rawOutput: string): T[] {
  const jsonlPayload = rawOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .join("\n");

  if (jsonlPayload.length === 0) {
    return [];
  }

  const results: T[] = [];
  let offset = 0;
  while (offset < jsonlPayload.length) {
    const chunk = Bun.JSONL.parseChunk(jsonlPayload.slice(offset));
    for (const val of chunk.values) {
      if (val && typeof val === "object") {
        results.push(val as T);
      }
    }
    if (chunk.done) {
      break;
    }
    if (chunk.read > 0) {
      offset += chunk.read;
    } else {
      const nextNl = jsonlPayload.indexOf("\n", offset);
      if (nextNl === -1) {
        break;
      }
      offset = nextNl + 1;
    }
  }

  return results;
}
