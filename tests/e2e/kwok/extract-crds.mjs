import { readFileSync, writeFileSync } from "fs";
import yaml from "js-yaml";
const [, , input, output] = process.argv;
const docs = yaml.loadAll(readFileSync(input, "utf8")).filter(d => d?.kind === "CustomResourceDefinition");
writeFileSync(output, docs.map(d => yaml.dump(d)).join("---\n"));
console.log(`${docs.length} CRDs: ${docs.map(d => d.metadata.name).join(", ")}`);
