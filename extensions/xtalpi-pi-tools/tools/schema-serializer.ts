import { safeInlineText } from "../text-safety.ts";

export type SchemaSerializationBudget = {
  maxDepth: number;
  maxPropertiesPerLevel: number;
  maxEnumItems: number;
  maxDescriptionChars: number;
  maxToolChars: number;
};

export const DEFAULT_SCHEMA_SERIALIZATION_BUDGET: Readonly<SchemaSerializationBudget> = {
  maxDepth: 3,
  maxPropertiesPerLevel: 16,
  maxEnumItems: 8,
  maxDescriptionChars: 160,
  maxToolChars: 1500,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJson(value: unknown, maxChars = 120): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return safeInlineText(serialized, maxChars);
}

function numericRange(schema: Record<string, unknown>): string {
  const lower = typeof schema.minimum === "number"
    ? `>=${schema.minimum}`
    : typeof schema.exclusiveMinimum === "number"
      ? `>${schema.exclusiveMinimum}`
      : "";
  const upper = typeof schema.maximum === "number"
    ? `<=${schema.maximum}`
    : typeof schema.exclusiveMaximum === "number"
      ? `<${schema.exclusiveMaximum}`
      : "";
  return [lower, upper].filter(Boolean).join(",");
}

function lengthRange(schema: Record<string, unknown>, prefix: "len" | "items"): string {
  const minKey = prefix === "len" ? "minLength" : "minItems";
  const maxKey = prefix === "len" ? "maxLength" : "maxItems";
  const lower = typeof schema[minKey] === "number" ? `>=${schema[minKey]}` : "";
  const upper = typeof schema[maxKey] === "number" ? `<=${schema[maxKey]}` : "";
  const range = [lower, upper].filter(Boolean).join(",");
  return range ? `${prefix}:${range}` : "";
}

function descriptionSuffix(schema: Record<string, unknown>, budget: SchemaSerializationBudget): string {
  return typeof schema.description === "string" && schema.description.trim()
    ? ` - ${safeInlineText(schema.description, budget.maxDescriptionChars)}`
    : "";
}

function variantList(
  variants: unknown[],
  depth: number,
  budget: SchemaSerializationBudget,
  kind: "oneOf" | "anyOf",
): string {
  const rendered = variants
    .slice(0, 6)
    .map((variant) => renderSchema(variant, depth + 1, budget))
    .join(" | ");
  const omitted = variants.length > 6 ? ` | ...+${variants.length - 6}` : "";
  return `${kind}(${rendered}${omitted})`;
}

function renderSchema(
  value: unknown,
  depth: number,
  budget: SchemaSerializationBudget,
): string {
  if (!isObject(value)) return "unknown";
  if (Object.prototype.hasOwnProperty.call(value, "const")) {
    return `const=${boundedJson(value.const)}`;
  }
  if (Array.isArray(value.enum)) {
    const items = value.enum.slice(0, budget.maxEnumItems).map((item) => boundedJson(item, 80));
    const omitted = value.enum.length > budget.maxEnumItems ? `,...+${value.enum.length - budget.maxEnumItems}` : "";
    return `enum[${items.join(",")}${omitted}]${descriptionSuffix(value, budget)}`;
  }
  if (Array.isArray(value.oneOf)) return `${variantList(value.oneOf, depth, budget, "oneOf")}${descriptionSuffix(value, budget)}`;
  if (Array.isArray(value.anyOf)) return `${variantList(value.anyOf, depth, budget, "anyOf")}${descriptionSuffix(value, budget)}`;

  const type = typeof value.type === "string" ? value.type : "object";
  if (depth >= budget.maxDepth) return `${safeInlineText(type, 40)}{...}`;

  if (type === "object" || isObject(value.properties)) {
    const properties = isObject(value.properties) ? value.properties : {};
    const required = new Set(Array.isArray(value.required) ? value.required.map(String) : []);
    const entries = Object.entries(properties).slice(0, budget.maxPropertiesPerLevel);
    const rendered = entries.map(([name, child]) => {
      const requirement = required.has(name) ? "required" : "optional";
      const childSchema = renderSchema(child, depth + 1, budget);
      const descriptionIndex = childSchema.indexOf(" - ");
      const schemaWithRequirement = descriptionIndex >= 0
        ? `${childSchema.slice(0, descriptionIndex)} ${requirement}${childSchema.slice(descriptionIndex)}`
        : `${childSchema} ${requirement}`;
      return `${safeInlineText(name, 80)}:${schemaWithRequirement}`;
    });
    if (Object.keys(properties).length > entries.length) {
      rendered.push(`...+${Object.keys(properties).length - entries.length}`);
    }
    const closed = value.additionalProperties === false ? ";closed" : "";
    return `{${rendered.join("; ")}${closed}}${descriptionSuffix(value, budget)}`;
  }

  if (type === "array") {
    const itemSchema = renderSchema(value.items, depth + 1, budget);
    const range = lengthRange(value, "items");
    return `array<${itemSchema}>${range ? `[${range}]` : ""}${descriptionSuffix(value, budget)}`;
  }

  const constraints = [
    type === "number" || type === "integer" ? numericRange(value) : "",
    type === "string" ? lengthRange(value, "len") : "",
  ].filter(Boolean);
  const format = typeof value.format === "string" ? `format:${safeInlineText(value.format, 60)}` : "";
  if (format) constraints.push(format);
  return `${safeInlineText(type, 40)}${constraints.length > 0 ? `[${constraints.join(";")}]` : ""}${descriptionSuffix(value, budget)}`;
}

export function serializeToolParameters(
  parameters: unknown,
  overrides: Partial<SchemaSerializationBudget> = {},
): string {
  const budget = { ...DEFAULT_SCHEMA_SERIALIZATION_BUDGET, ...overrides };
  const rendered = renderSchema(parameters, 0, budget);
  if (rendered.length <= budget.maxToolChars) return rendered;
  return `${rendered.slice(0, Math.max(0, budget.maxToolChars - 18))}...[schema clipped]`;
}
