/**
 * Naming a package by the bridge label on an object it defines.
 *
 * A bridge operator's documentation lists its Sui state objects more often
 * than its package ids, and a package upgrade leaves those objects in place.
 * An object's type names the package that defined it, so a curated bridge
 * label on an object whose type a package defines names that package's
 * operator: the label is the operator's own statement and the type is chain
 * data.
 */

import { gqlQuery } from "../../clients/graphql.js";
import { getNetwork } from "../../config.js";
import { canonicalSuiAddress, currentSuiChain } from "../chain-id.js";
import { allLabels, getLabel, labelProvenance, type LabelProvenance } from "../labels.js";
import { lookupProtocol } from "../../protocols/registry.js";
import { getPackageRoot, prefetchPackageRoots } from "../../protocols/package-roots.js";

export interface LabeledObjectOfPackage {
  object: string;
  object_type: string;
  label: string;
  entity: string | null;
  provenance?: LabelProvenance;
}

const OBJECT_TYPES_QUERY = `query ($keys: [ObjectKey!]!) {
  multiGetObjects(keys: $keys) { address asMoveObject { contents { type { repr } } } }
}`;

interface ObjectTypesResult {
  multiGetObjects?: Array<{ address?: string; asMoveObject?: { contents?: { type?: { repr?: string } } } | null } | null>;
}

/** Keys per request: the service caps a query at 5,000 bytes and a key costs about 81. */
const BATCH = 40;

/** `network:address` → the object's type, or null for a package or no object. */
const typeCache = new Map<string, string | null>();

/**
 * The bridge-labeled objects on this network whose type one of `packageIds`
 * defines: pass every known version of a lineage, since a type is named for
 * the version that introduced it.
 * Types are read once per labeled address and cached; a batch that fails is
 * left unread and retried on the next call. Empty off-label or on failure,
 * which clears nothing.
 */
export async function bridgeLabeledObjectsOf(packageIds: string[]): Promise<LabeledObjectOfPackage[]> {
  const packages = new Set(packageIds.map(canonicalSuiAddress).filter((p): p is string => p !== null));
  if (packages.size === 0) return [];
  const network = getNetwork();
  const chain = currentSuiChain();
  const labeled = allLabels().filter((l) => l.chain === chain && l.category === "bridge");
  const unread = labeled.map((l) => l.address).filter((a) => !typeCache.has(`${network}:${a}`));
  for (let i = 0; i < unread.length; i += BATCH) {
    const chunk = unread.slice(i, i + BATCH);
    let objects: ObjectTypesResult["multiGetObjects"];
    try {
      objects = (await gqlQuery<ObjectTypesResult>(OBJECT_TYPES_QUERY, { keys: chunk.map((address) => ({ address })) }))?.multiGetObjects;
    } catch {
      continue;
    }
    if (!Array.isArray(objects)) continue;
    // Positional: the response mirrors the keys.
    chunk.forEach((a, j) => typeCache.set(`${network}:${a}`, objects?.[j]?.asMoveObject?.contents?.type?.repr ?? null));
  }
  return labeled.flatMap((l) => {
    const type = typeCache.get(`${network}:${l.address}`);
    const definer = type ? canonicalSuiAddress(type.split("::")[0]) : null;
    if (!type || !definer || !packages.has(definer)) return [];
    const provenance = labelProvenance(l);
    return [{ object: l.address, object_type: type, label: l.label, entity: l.entity ?? null, ...(provenance ? { provenance } : {}) }];
  });
}

/** Who a bridge package belongs to, and on what basis. */
export interface BridgePackageName {
  name: string;
  /**
   * `registry`: the protocol registry types the package or its lineage as a
   * bridge. `package-label`: the package carries a bridge label.
   * `labeled-object`: an object of a type the package defines carries one.
   */
  identified_via: "registry" | "package-label" | "labeled-object";
  label?: string;
  provenance?: LabelProvenance;
  labeled_objects?: LabeledObjectOfPackage[];
}

/** The curated name of a bridge package, strongest basis first; null when none names it. */
export async function nameBridgePackage(packageId: string): Promise<BridgePackageName | null> {
  await prefetchPackageRoots([packageId]);
  const registry = lookupProtocol(packageId);
  if (registry?.type === "bridge") return { name: registry.name, identified_via: "registry" };
  const label = getLabel(packageId);
  if (label?.category === "bridge") {
    const provenance = labelProvenance(label);
    return { name: label.entity ?? label.label, identified_via: "package-label", label: label.label, ...(provenance ? { provenance } : {}) };
  }
  const root = getPackageRoot(packageId);
  const objects = await bridgeLabeledObjectsOf([packageId, ...(root ? [root] : [])]);
  return objects.length ? { name: objects[0].entity ?? objects[0].label, identified_via: "labeled-object", labeled_objects: objects } : null;
}

/** Test seam: drops the cached object types. */
export function clearLabeledObjectTypes(): void {
  typeCache.clear();
}
