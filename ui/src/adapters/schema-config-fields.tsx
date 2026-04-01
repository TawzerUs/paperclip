import { useState, useEffect } from "react";

import type { AdapterConfigSchema, ConfigFieldSchema, CreateConfigValues } from "@paperclipai/adapter-utils";

import type { AdapterConfigFieldsProps } from "./types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
  DraftTextarea,
  ToggleField,
} from "../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono";

// ---------------------------------------------------------------------------
// Schema cache (module-level, survives re-renders)
// ---------------------------------------------------------------------------

const schemaCache = new Map<string, AdapterConfigSchema | null>();
const schemaFetchInflight = new Map<string, Promise<AdapterConfigSchema | null>>();
const failedSchemaTypes = new Set<string>();

async function fetchConfigSchema(adapterType: string): Promise<AdapterConfigSchema | null> {
  const cached = schemaCache.get(adapterType);
  if (cached !== undefined) return cached;
  if (failedSchemaTypes.has(adapterType)) return null;

  const inflight = schemaFetchInflight.get(adapterType);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const res = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/config-schema`);
      if (!res.ok) {
        failedSchemaTypes.add(adapterType);
        return null;
      }
      const schema = (await res.json()) as AdapterConfigSchema;
      schemaCache.set(adapterType, schema);
      return schema;
    } catch {
      failedSchemaTypes.add(adapterType);
      return null;
    } finally {
      schemaFetchInflight.delete(adapterType);
    }
  })();

  schemaFetchInflight.set(adapterType, promise);
  return promise;
}

export function invalidateConfigSchemaCache(adapterType: string): void {
  schemaCache.delete(adapterType);
  failedSchemaTypes.delete(adapterType);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function useConfigSchema(adapterType: string): AdapterConfigSchema | null {
  const [schema, setSchema] = useState<AdapterConfigSchema | null>(
    schemaCache.get(adapterType) ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    fetchConfigSchema(adapterType).then((s) => {
      if (!cancelled) setSchema(s);
    });
    return () => {
      cancelled = true;
    };
  }, [adapterType]);

  return schema;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultValue(field: ConfigFieldSchema): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "toggle":
      return false;
    case "number":
      return 0;
    case "text":
    case "textarea":
      return "";
    case "select":
      return field.options?.[0]?.value ?? "";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SchemaConfigFields({
  adapterType,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const schema = useConfigSchema(adapterType);

  const [defaultsApplied, setDefaultsApplied] = useState(false);
  useEffect(() => {
    if (!schema || !isCreate || defaultsApplied) return;
    const defaults: Record<string, unknown> = {};
    for (const field of schema.fields) {
      const def = getDefaultValue(field);
      if (def !== undefined && def !== "") {
        defaults[field.key] = def;
      }
    }
    if (Object.keys(defaults).length > 0) {
      set?.({
        adapterSchemaValues: { ...values?.adapterSchemaValues, ...defaults },
      });
    }
    setDefaultsApplied(true);
  }, [schema, isCreate, defaultsApplied, set, values?.adapterSchemaValues]);

  if (!schema || schema.fields.length === 0) return null;

  function readValue(field: ConfigFieldSchema): unknown {
    if (isCreate) {
      return values?.adapterSchemaValues?.[field.key] ?? getDefaultValue(field);
    }
    const stored = config[field.key];
    return eff("adapterConfig", field.key, (stored ?? getDefaultValue(field)) as string);
  }

  function writeValue(field: ConfigFieldSchema, value: unknown): void {
    if (isCreate) {
      set?.({
        adapterSchemaValues: {
          ...values?.adapterSchemaValues,
          [field.key]: value,
        },
      });
    } else {
      mark("adapterConfig", field.key, value);
    }
  }

  return (
    <>
      {schema.fields.map((field) => {
        switch (field.type) {
          case "select":
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <select
                  className={selectClass}
                  value={String(readValue(field) ?? "")}
                  onChange={(e) => writeValue(field, e.target.value)}
                >
                  {field.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
            );

          case "toggle":
            return (
              <ToggleField
                key={field.key}
                label={field.label}
                hint={field.hint}
                checked={readValue(field) === true}
                onChange={(v) => writeValue(field, v)}
              />
            );

          case "number":
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <DraftNumberInput
                  value={Number(readValue(field) ?? 0)}
                  onCommit={(v) => writeValue(field, v)}
                  immediate
                  className={inputClass}
                />
              </Field>
            );

          case "textarea":
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <DraftTextarea
                  value={String(readValue(field) ?? "")}
                  onCommit={(v) => writeValue(field, v || undefined)}
                  immediate
                />
              </Field>
            );

          case "text":
          default:
            return (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <DraftInput
                  value={String(readValue(field) ?? "")}
                  onCommit={(v) => writeValue(field, v || undefined)}
                  immediate
                  className={inputClass}
                />
              </Field>
            );
        }
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Build adapter config from schema values + standard CreateConfigValues fields
// ---------------------------------------------------------------------------

export function buildSchemaAdapterConfig(
  values: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (values.model?.trim()) ac.model = values.model.trim();
  if (values.cwd) ac.cwd = values.cwd;
  if (values.command) ac.command = values.command;
  if (values.instructionsFilePath) ac.instructionsFilePath = values.instructionsFilePath;
  if (values.thinkingEffort) ac.thinkingEffort = values.thinkingEffort;

  if (values.extraArgs) {
    ac.extraArgs = values.extraArgs
      .split(/\s+/)
      .filter(Boolean);
  }

  if (values.adapterSchemaValues) {
    Object.assign(ac, values.adapterSchemaValues);
  }

  return ac;
}
