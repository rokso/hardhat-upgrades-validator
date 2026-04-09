// src/plugin/annotation-utils.ts
// Utilities for extracting and embedding upgrades-validator annotations from build-info and into OZ layouts

import { astDereferencer } from "solidity-ast/utils.js";
import type { UnsafeAllowKind } from "../../types/validation.js";
import type { BuildInfoParsed } from "./build-info-utils.js";
import type { StorageLayout } from "@openzeppelin/upgrades-core";

// Annotation name constants
const ANNOTATION_PREFIX = "upgrades-validator";
const ANN_RENAMED_FROM = `custom:${ANNOTATION_PREFIX}-renamed-from` as const;
const ANN_RETYPED_FROM = `custom:${ANNOTATION_PREFIX}-retyped-from` as const;
const ANN_UNSAFE_ALLOW = `custom:${ANNOTATION_PREFIX}-unsafe-allow` as const;

const STORAGE_LOCATION_RE = /@custom:storage-location\s+(\S+)/;
const MEMBER_RENAMED_FROM_RE = new RegExp(
  `@custom:${ANNOTATION_PREFIX}-renamed-from\\s+(\\S+)\\s+(\\S+)`,
  "g",
);
const MEMBER_RETYPED_FROM_RE = new RegExp(
  `@custom:${ANNOTATION_PREFIX}-retyped-from\\s+(\\S+)\\s+(\\S+)`,
  "g",
);

function getDocText(doc: { text: string } | string | undefined): string {
  if (!doc) return "";
  return typeof doc === "string" ? doc : doc.text;
}

export function extractAnnotationMaps(
  parsed: BuildInfoParsed,
  simpleContractName: string,
  winnerSource: string,
  parseUnsafeAllowAnnotation: (raw: unknown, context?: string) => UnsafeAllowKind[],
): {
  renameAnnotations: Map<string, string>;
  retypeAnnotations: Map<string, string>;
  perVariableUnsafeAllow: Map<string, UnsafeAllowKind[]>;
  namespaceUnsafeAllow: Map<string, UnsafeAllowKind[]>;
  namespaceMemberRenameAnnotations: Map<string, Map<string, string>>;
  namespaceMemberRetypeAnnotations: Map<string, Map<string, string>>;
  structMemberRenameAnnotations: Map<string, Map<string, string>>;
  structMemberRetypeAnnotations: Map<string, Map<string, string>>;
  unsafeAllowFromAnnotation: UnsafeAllowKind[];
} {
  const { contracts, sources } = parsed;
  const winner = contracts[winnerSource]?.[simpleContractName];

  // --- State variable annotations from devdoc ---
  const renameAnnotations = new Map<string, string>();
  const retypeAnnotations = new Map<string, string>();
  const perVariableUnsafeAllow = new Map<string, UnsafeAllowKind[]>();

  for (const [label, tags] of Object.entries(winner?.devdoc?.stateVariables ?? {})) {
    const oldLabel = tags[ANN_RENAMED_FROM];
    if (typeof oldLabel === "string" && oldLabel.trim() !== "") {
      renameAnnotations.set(label, oldLabel.trim().split(/\s+/)[0]!);
    }
    const oldType = tags[ANN_RETYPED_FROM];
    if (typeof oldType === "string" && oldType.trim() !== "") {
      retypeAnnotations.set(label, oldType.trim().split(/\s+/)[0]!);
    }
    const varKinds = parseUnsafeAllowAnnotation(
      tags[ANN_UNSAFE_ALLOW],
      `contract ${simpleContractName}, variable "${label}"`,
    );
    if (varKinds.length > 0) perVariableUnsafeAllow.set(label, varKinds);
  }

  // Merge contract-level and constructor-method-level unsafe-allow annotations.
  const contractLevelAllow = parseUnsafeAllowAnnotation(
    winner?.devdoc?.[ANN_UNSAFE_ALLOW],
    `contract ${simpleContractName}`,
  );
  const constructorLevelAllow = parseUnsafeAllowAnnotation(
    winner?.devdoc?.methods?.["constructor"]?.[ANN_UNSAFE_ALLOW],
    `contract ${simpleContractName} constructor`,
  );
  const unsafeAllowFromAnnotation = [...new Set([...contractLevelAllow, ...constructorLevelAllow])];

  // --- Struct NatSpec annotations from AST ---
  const namespaceMemberRenameAnnotations = new Map<string, Map<string, string>>();
  const namespaceMemberRetypeAnnotations = new Map<string, Map<string, string>>();
  const structMemberRenameAnnotations = new Map<string, Map<string, string>>();
  const structMemberRetypeAnnotations = new Map<string, Map<string, string>>();
  const namespaceUnsafeAllow = new Map<string, UnsafeAllowKind[]>();

  const sourcesWithAst = Object.fromEntries(
    Object.entries(sources).filter(([, v]) => v.ast != null),
  ) as Record<string, { ast: unknown }>;

  const contractDef = (
    sourcesWithAst[winnerSource]?.ast as { nodes: unknown[] } | undefined
  )?.nodes?.find(
    (n: unknown) =>
      (n as { nodeType: string }).nodeType === "ContractDefinition" &&
      (n as { name: string }).name === simpleContractName,
  ) as { linearizedBaseContracts?: number[] } | undefined;

  if (contractDef?.linearizedBaseContracts) {
    const deref = astDereferencer({ sources: sourcesWithAst as never });

    for (const baseId of contractDef.linearizedBaseContracts) {
      let baseDef: { nodes?: unknown[] } | undefined;
      try {
        baseDef = deref("ContractDefinition", baseId) as unknown as {
          nodes?: unknown[];
        };
      } catch {
        continue;
      }

      for (const node of baseDef?.nodes ?? []) {
        if ((node as { nodeType: string }).nodeType !== "StructDefinition") continue;
        const structDoc = getDocText(
          (node as { documentation?: { text: string } | string }).documentation,
        );
        if (!structDoc) continue;

        const renameMap = new Map<string, string>();
        MEMBER_RENAMED_FROM_RE.lastIndex = 0;
        let rm: RegExpExecArray | null;
        while ((rm = MEMBER_RENAMED_FROM_RE.exec(structDoc)) !== null) {
          renameMap.set(rm[2]!, rm[1]!);
        }

        const retypeMap = new Map<string, string>();
        MEMBER_RETYPED_FROM_RE.lastIndex = 0;
        let rt: RegExpExecArray | null;
        while ((rt = MEMBER_RETYPED_FROM_RE.exec(structDoc)) !== null) {
          retypeMap.set(rt[2]!, rt[1]!);
        }

        const locationMatch = STORAGE_LOCATION_RE.exec(structDoc);
        if (locationMatch) {
          const storageLocation = locationMatch[1]!;
          if (renameMap.size > 0) namespaceMemberRenameAnnotations.set(storageLocation, renameMap);
          if (retypeMap.size > 0) namespaceMemberRetypeAnnotations.set(storageLocation, retypeMap);

          const unsafeAllowMatch = structDoc.match(
            new RegExp(`@custom:${ANNOTATION_PREFIX}-unsafe-allow\\s+([^\\n@]+)`),
          );
          if (unsafeAllowMatch) {
            const kinds = parseUnsafeAllowAnnotation(
              unsafeAllowMatch[1],
              `namespace "${storageLocation}" in contract ${simpleContractName}`,
            );
            if (kinds.length > 0) namespaceUnsafeAllow.set(storageLocation, kinds);
          }
        } else {
          const canonicalName = (node as { canonicalName?: string }).canonicalName;
          if (canonicalName) {
            if (renameMap.size > 0) structMemberRenameAnnotations.set(canonicalName, renameMap);
            if (retypeMap.size > 0) structMemberRetypeAnnotations.set(canonicalName, retypeMap);
          }
        }
      }
    }
  }

  return {
    renameAnnotations,
    retypeAnnotations,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    namespaceMemberRenameAnnotations,
    namespaceMemberRetypeAnnotations,
    structMemberRenameAnnotations,
    structMemberRetypeAnnotations,
    unsafeAllowFromAnnotation,
  };
}

export function embedAnnotations(
  layout: StorageLayout,
  renameAnnotations: Map<string, string>,
  retypeAnnotations: Map<string, string>,
  namespaceMemberRenameAnnotations: Map<string, Map<string, string>>,
  namespaceMemberRetypeAnnotations: Map<string, Map<string, string>>,
  structMemberRenameAnnotations: Map<string, Map<string, string>>,
  structMemberRetypeAnnotations: Map<string, Map<string, string>>,
): StorageLayout {
  // Regular storage items
  for (const item of layout.storage) {
    const oldLabel = renameAnnotations.get(item.label);
    if (oldLabel !== undefined) item.renamedFrom = oldLabel;
    const oldType = retypeAnnotations.get(item.label);
    if (oldType !== undefined) item.retypedFrom = oldType;
  }

  // Namespace items
  if (layout.namespaces) {
    for (const [nsId, items] of Object.entries(layout.namespaces)) {
      const renameMap = namespaceMemberRenameAnnotations.get(nsId);
      const retypeMap = namespaceMemberRetypeAnnotations.get(nsId);
      for (const item of items) {
        const oldLabel = renameMap?.get(item.label);
        if (oldLabel !== undefined) item.renamedFrom = oldLabel;
        const oldType = retypeMap?.get(item.label);
        if (oldType !== undefined) item.retypedFrom = oldType;
      }
    }
  }

  // Struct type members
  for (const typeInfo of Object.values(layout.types ?? {})) {
    const members = (
      typeInfo as {
        members?: Array<{
          label: string;
          renamedFrom?: string;
          retypedFrom?: string;
        }>;
      }
    ).members;
    if (!members) continue;
    const typeLabel = (typeInfo as { label: string }).label;
    if (!typeLabel.startsWith("struct ")) continue;
    const canonicalName = typeLabel.slice("struct ".length);
    const renameMap = structMemberRenameAnnotations.get(canonicalName);
    const retypeMap = structMemberRetypeAnnotations.get(canonicalName);
    if (!renameMap && !retypeMap) continue;
    for (const member of members) {
      const oldLabel = renameMap?.get(member.label);
      if (oldLabel !== undefined) member.renamedFrom = oldLabel;
      const oldType = retypeMap?.get(member.label);
      if (oldType !== undefined) member.retypedFrom = oldType;
    }
  }

  return layout;
}
