import { z } from "zod";

export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export const jsonSchemaToZodShape = (inputSchema: JsonSchema): Record<string, z.ZodTypeAny> => {
  if (!inputSchema || typeof inputSchema !== "object" || !inputSchema.properties) {
    return {};
  }

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, value] of Object.entries(inputSchema.properties)) {
    const prop = value;

    let zodType: z.ZodTypeAny;

    switch (prop.type) {
    case "string":
      zodType = z.string();
      break;
    case "number":
      zodType = z.number();
      break;
    case "integer":
      zodType = z.number().int();
      break;
    case "boolean":
      zodType = z.boolean();
      break;
    case "array":
      if (prop.items?.type === "string") {
        zodType = z.array(z.string());
      } else if (prop.items?.type === "number") {
        zodType = z.array(z.number());
      } else if (prop.items?.type === "integer") {
        zodType = z.array(z.number().int());
      } else if (prop.items?.type === "boolean") {
        zodType = z.array(z.boolean());
      } else if (prop.items?.type === "object") {
        zodType = z.array(z.record(z.string(), z.unknown()));
      } else {
        zodType = z.array(z.unknown());
      }
      break;
    case "object":
      if (prop.properties) {
        const nestedShape = jsonSchemaToZodShape(prop);

        zodType = z.object(nestedShape);
      } else {
        zodType = z.record(z.string(), z.unknown());
      }

      break;
    default:
      zodType = z.unknown();
    }

    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    if (!inputSchema.required?.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return shape;
};
