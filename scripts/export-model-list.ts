// docs/318 — writes the catalogue's model rows to the file installs read from `main`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_LIST_REPO_PATH,
  exportModelList,
  serializeModelList,
} from "../src/server/shared/catalogue/model-list.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.writeFileSync(path.join(root, MODEL_LIST_REPO_PATH), serializeModelList(exportModelList()));
console.log(`wrote ${MODEL_LIST_REPO_PATH}`);
