// src/plugin/annotation-utils.ts
// Struct-member rename/retype tags: the one annotation OZ does not extract.
//
// OZ reads `@custom:oz-renamed-from` / `@custom:oz-retyped-from` on state
// variables, and its comparator honors `renamedFrom` / `retypedFrom` on struct
// members, but its extraction never sets them on members (Solidity has no
// NatSpec on struct members). So the tags go on the struct's own NatSpec:
//
//   @custom:upgrades-validator-renamed-from <oldName> <member>
//   @custom:upgrades-validator-retyped-from <oldType> <member>
//
// This covers plain structs (keyed by canonical name) and ERC-7201 namespace
// structs (keyed by `@custom:storage-location`).

import { astDereferencer } from "solidity-ast/utils.js";
import type { BuildInfoParsed } from "./build-info-utils.js";
import type { StorageLayout } from "@openzeppelin/upgrades-core";

const ANNOTATION_PREFIX = "upgrades-validator";

const STORAGE_LOCATION_RE = /@custom:storage-location\s+(\S+)/;
const MEMBER_RENAMED_FROM_RE = new RegExp(
  `@custom:${ANNOTATION_PREFIX}-renamed-from\\s+(\\S+)\\s+(\\S+)`,
  "g",
);
const MEMBER_RETYPED_FROM_RE = new RegExp(
  `@custom:${ANNOTATION_PREFIX}-retyped-from\\s+(\\S+)\\s+(\\S+)`,
  "g",
);

/** member label -> old name or old type, per struct canonical name or namespace id */
type MemberMaps = Map<string, Map<string, string>>;

export interface StructMemberAnnotations {
  namespaceMemberRename: MemberMaps;
  namespaceMemberRetype: MemberMaps;
  structMemberRename: MemberMaps;
  structMemberRetype: MemberMaps;
}

function getDocText(doc: { text: string } | string | undefined): string {
  if (!doc) return "";
  return typeof doc === "string" ? doc : doc.text;
}

function memberMap(re: RegExp, doc: string): Map<string, string> {
  const map = new Map<string, string>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    map.set(m[2]!, m[1]!);
  }
  return map;
}

export function extractStructMemberAnnotations(
  parsed: BuildInfoParsed,
  simpleContractName: string,
  winnerSource: string,
): StructMemberAnnotations {
  const result: StructMemberAnnotations = {
    namespaceMemberRename: new Map(),
    namespaceMemberRetype: new Map(),
    structMemberRename: new Map(),
    structMemberRetype: new Map(),
  };

  const sourcesWithAst = Object.fromEntries(
    Object.entries(parsed.sources).filter(([, v]) => v.ast != null),
  ) as Record<string, { ast: unknown }>;

  const contractDef = (
    sourcesWithAst[winnerSource]?.ast as { nodes: unknown[] } | undefined
  )?.nodes?.find(
    (n: unknown) =>
      (n as { nodeType: string }).nodeType === "ContractDefinition" &&
      (n as { name: string }).name === simpleContractName,
  ) as { linearizedBaseContracts?: number[] } | undefined;

  if (!contractDef?.linearizedBaseContracts) return result;

  const deref = astDereferencer({ sources: sourcesWithAst as never });

  for (const baseId of contractDef.linearizedBaseContracts) {
    let baseDef: { nodes?: unknown[] } | undefined;
    try {
      baseDef = deref("ContractDefinition", baseId) as unknown as { nodes?: unknown[] };
    } catch {
      continue;
    }

    for (const node of baseDef?.nodes ?? []) {
      if ((node as { nodeType: string }).nodeType !== "StructDefinition") continue;
      const structDoc = getDocText(
        (node as { documentation?: { text: string } | string }).documentation,
      );
      if (!structDoc) continue;

      const renameMap = memberMap(MEMBER_RENAMED_FROM_RE, structDoc);
      const retypeMap = memberMap(MEMBER_RETYPED_FROM_RE, structDoc);

      const locationMatch = STORAGE_LOCATION_RE.exec(structDoc);
      const key = locationMatch
        ? locationMatch[1]!
        : (node as { canonicalName?: string }).canonicalName;
      if (!key) continue;

      const renames = locationMatch ? result.namespaceMemberRename : result.structMemberRename;
      const retypes = locationMatch ? result.namespaceMemberRetype : result.structMemberRetype;
      if (renameMap.size > 0) renames.set(key, renameMap);
      if (retypeMap.size > 0) retypes.set(key, retypeMap);
    }
  }

  return result;
}

export function embedStructMemberAnnotations(
  layout: StorageLayout,
  annotations: StructMemberAnnotations,
): StorageLayout {
  // Namespace members
  for (const [nsId, items] of Object.entries(layout.namespaces ?? {})) {
    const renameMap = annotations.namespaceMemberRename.get(nsId);
    const retypeMap = annotations.namespaceMemberRetype.get(nsId);
    for (const item of items) {
      const oldLabel = renameMap?.get(item.label);
      if (oldLabel !== undefined) item.renamedFrom = oldLabel;
      const oldType = retypeMap?.get(item.label);
      if (oldType !== undefined) item.retypedFrom = oldType;
    }
  }

  // Struct type members
  for (const typeInfo of Object.values(layout.types ?? {})) {
    const members = (
      typeInfo as {
        members?: Array<{ label: string; renamedFrom?: string; retypedFrom?: string }>;
      }
    ).members;
    if (!members) continue;
    const typeLabel = (typeInfo as { label: string }).label;
    if (!typeLabel.startsWith("struct ")) continue;
    const canonicalName = typeLabel.slice("struct ".length);
    const renameMap = annotations.structMemberRename.get(canonicalName);
    const retypeMap = annotations.structMemberRetype.get(canonicalName);
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
