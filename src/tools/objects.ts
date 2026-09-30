import { z } from "zod";
import { numArg, addressArg, u64StringArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
import { clampPageSize } from "../utils/pagination.js";
import { protoValueToJson } from "../utils/proto.js";
import { formatOwner } from "../utils/formatting.js";
import { objectAddressBalanceFields } from "../utils/address-balance.js";
import { baseType } from "../utils/object-flow.js";
import { KIOSK_TYPE, resolveKioskCapHolder, unresolvedCapHolderNote } from "../utils/kiosk.js";
import { capPayload } from "../utils/output-cap.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The Display standard, which is not in the object's own fields.
 *
 * `0x2::display::Display<T>` is a template registered per type and rendered
 * per object, so an NFT's name and image usually live nowhere in its struct.
 * Its `contents.json` can hold only fields like
 * `id, number, index, attributes, metadata_version`, while the rendered
 * Display carries creator, description and image_url. The field-guessing
 * below finds nothing on such an object, so the rendered Display is read
 * when the fields carry no display metadata.
 *
 * gRPC has no rendered Display, so this is GraphQL: the same exception, for
 * the same reason, as event field JSON.
 */
const DISPLAY_QUERY = `
  query($id: SuiAddress!) {
    object(address: $id) {
      asMoveObject { contents { display { output } } }
    }
  }
`;

async function fetchDisplayStandard(objectId: string): Promise<Record<string, string> | null> {
  try {
    const d = await gqlQuery<{
      object?: { asMoveObject?: { contents?: { display?: { output?: Record<string, unknown> | null } | null } | null } | null };
    }>(DISPLAY_QUERY, { id: objectId });
    const out = d.object?.asMoveObject?.contents?.display?.output;
    if (!out) return null;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === "string" && v) clean[k] = v;
    }
    return Object.keys(clean).length ? clean : null;
  } catch {
    // Supplementary. The object read already succeeded and is the answer.
    return null;
  }
}

function extractDisplay(content: unknown): Record<string, string | null> | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const c = content as Record<string, unknown>;
  const display: Record<string, string | null> = {};
  let hasAny = false;
  if (typeof c.name === "string") { display.name = c.name; hasAny = true; }
  if (typeof c.description === "string") { display.description = c.description; hasAny = true; }
  for (const field of ["image_url", "img_url", "url", "thumbnail"]) {
    if (typeof c[field] === "string" && !display.image_url) {
      display.image_url = c[field] as string;
      hasAny = true;
    }
  }
  if (typeof c.project_url === "string") { display.project_url = c.project_url; hasAny = true; }
  return hasAny ? display : null;
}

export function registerObjectTools(server: McpServer) {
  server.tool(
    "get_object",
    "Get a Sui object by its ID. Returns type, owner, version, content (JSON), and digest. Automatically extracts display metadata (name, description, image_url) for NFTs. For the LATEST version it also lists `address_balances` (funds the object holds in its own address balance, which are not among its fields and which only its defining module can withdraw) and, for a kiosk, `kiosk_cap_holder`: who actually controls it today, since `content.owner` is self-declared and not kept in sync with the KioskOwnerCap transfer that does. Neither is read for a specific `version`: both are current state and would misname a past snapshot's controller.",
    {
      object_id: addressArg().describe("The object ID (0x...)"),
      version: u64StringArg().optional().describe("Specific version to fetch"),
    },
    async ({ object_id, version }) => {
      const readMask = {
        paths: [
          "object_id", "version", "digest", "object_type", "owner",
          "previous_transaction", "storage_rebate", "json", "balance",
        ],
      };
      const req = {
        objectId: object_id,
        version: version ? BigInt(version) : undefined,
        readMask,
      };
      // Only a versioned read is expected to hit pruned state; the latest
      // version of a live object being absent means it genuinely doesn't exist,
      // and asking the archive would just cost a round trip to learn the same.
      const res = await withArchiveFallback(
        (client) => client.ledgerService.getObject(req),
        (r) => !r.object && !!version,
      );
      const obj = res.object;
      const content = protoValueToJson(obj?.json);
      // Funds held in the object's own address balance are current state, so
      // they are read only for the latest version, alongside the Display.
      const heldRequest = !version && obj?.objectId ? objectAddressBalanceFields(obj.objectId) : null;
      // The struct's own fields first, because they cost nothing. Only when
      // they carry nothing is the rendered Display worth a second request.
      let display: Record<string, string | null> | null = extractDisplay(content);
      let displaySource: "object_fields" | "display_standard" | undefined = display
        ? "object_fields"
        : undefined;
      if (!display && obj?.objectId) {
        const rendered = await fetchDisplayStandard(obj.objectId);
        if (rendered) {
          display = rendered;
          displaySource = "display_standard";
        }
      }
      const held = heldRequest ? await heldRequest : {};
      // `Kiosk.owner` (visible in `content` above) is a self-declared field
      // the framework does not update when the `KioskOwnerCap` that
      // controls the kiosk is transferred, so it can name a former owner.
      // `kiosk_cap_holder` is read from the cap's own current owner instead,
      // the only party who can list, delist or withdraw from this kiosk. Only
      // for the latest version, like `heldRequest` above: the cap's current
      // holder is not who controlled the kiosk in a past snapshot.
      const kiosk =
        !version && obj?.objectType && baseType(obj.objectType) === KIOSK_TYPE && obj.objectId
          ? await resolveKioskCapHolder(obj.objectId)
          : null;

      const result: Record<string, unknown> = {
        object_id: obj?.objectId,
        version: obj?.version?.toString(),
        digest: obj?.digest,
        object_type: obj?.objectType,
        owner: formatOwner(obj?.owner),
        previous_transaction: obj?.previousTransaction,
        storage_rebate: obj?.storageRebate?.toString(),
        content,
        balance: obj?.balance?.toString(),
        ...held,
        ...(kiosk
          ? {
              kiosk_owner_field_caveat:
                "The `owner` field above (inside `content`) is self-declared: it is set when the kiosk is created or by `set_owner`, and does not follow the KioskOwnerCap when the cap is transferred, so it can name a former owner. `kiosk_cap_holder` is who actually controls this kiosk, read from the cap's own current owner.",
              ...(kiosk.status === "resolved"
                ? {
                    kiosk_cap_holder: kiosk.result.holder,
                    kiosk_cap_id: kiosk.result.cap_id,
                    ...(kiosk.result.wrapped_in ? { kiosk_cap_wrapped_in: kiosk.result.wrapped_in } : {}),
                    ...(kiosk.result.holder ? {} : { kiosk_cap_holder_note: unresolvedCapHolderNote(kiosk.result) }),
                  }
                : {
                    kiosk_cap_holder_note:
                      kiosk.status === "creation_unreachable"
                        ? "The kiosk's creation transaction could not be read, so its KioskOwnerCap could not be found."
                        : kiosk.status === "cap_not_found"
                          ? `No KioskOwnerCap naming this kiosk was found in its creation transaction (scanned ${kiosk.scanned_pages} page(s)${kiosk.truncated ? ", truncated before reaching the end" : ""}).`
                          : `The KioskOwnerCap lookup failed and was skipped: ${kiosk.message}`,
                  }),
            }
          : {}),
      };

      if (display) {
        result.display = display;
        result.display_source = displaySource;
      }

      return {
        content: [
          {
            type: "text" as const,
            // Compact: indentation would bloat a large object's output.
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  server.tool(
    "list_owned_objects",
    "List raw objects owned by a Sui address with optional type filter and pagination. `count` covers every object of the page; the default view lists the objects that fit about 30k characters in page order and states the rest under `omitted`, and `detail: 'full'` lists the whole page. `next_cursor` continues after the whole page, rows under `omitted` included. For NFTs specifically, prefer list_nfts (resolves kiosk storage, extracts display metadata). For a wallet summary, prefer get_wallet_overview.",
    {
      owner: addressArg().optional().describe("Owner address (0x...). Required; `address` is accepted in its place."),
      address: addressArg().optional().describe("Alias for `owner`."),
      object_type: z
        .string()
        .optional()
        .describe("Filter by object type (e.g. 0x2::coin::Coin<0x2::sui::SUI>)"),
      limit: numArg().int().min(1).max(1000).optional().describe("Max results (default 50, max 1000)"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): the objects that fit about 30k characters, in page order, the rest counted under `omitted`. 'full': every object of the page."),
    },
    async ({ owner: ownerArg, address, object_type, limit, cursor, detail }) => {
      const owner = ownerArg ?? address;
      if (!owner) return errorResult("Pass the wallet to list as `owner` (or `address`).");
      const res = await sui.listOwnedObjects({
        owner,
        type: object_type,
        limit: clampPageSize(limit),
        cursor: cursor ?? null,
      });
      const objects = res.objects.map((obj) => ({
        object_id: obj.objectId,
        version: obj.version,
        object_type: obj.type,
        digest: obj.digest,
        owner: formatOwnerSdk(obj.owner),
      }));
      const { payload } = capPayload(
        "list_owned_objects",
        { owner, object_type, limit, cursor },
        { count: objects.length, objects, next_cursor: res.cursor },
        { objects: { budget: 30_000, keepOrder: true } },
        { full: detail === "full", next_call: { tool: "list_owned_objects", repeat_with: { detail: "full" } } },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    }
  );

  server.tool(
    "list_dynamic_fields",
    "(Developer) List dynamic fields of a Sui object. Returns field names, types, and values. Useful for inspecting on-chain tables, kiosk contents, or other dynamic collections.",
    {
      parent_id: addressArg().describe("Parent object ID (0x...)"),
      limit: numArg().int().min(1).max(1000).optional().describe("Max results (default 50, max 1000)"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
    },
    async ({ parent_id, limit, cursor }) => {
      const res = await sui.listDynamicFields({
        parentId: parent_id,
        limit: clampPageSize(limit),
        cursor: cursor ?? null,
      });
      const fields = res.dynamicFields.map((df) => ({
        field_id: df.fieldId,
        type: df.type,
        value_type: df.valueType,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              dynamic_fields: fields,
              has_next_page: res.hasNextPage,
              next_cursor: res.cursor,
            }),
          },
        ],
      };
    }
  );
}

function formatOwnerSdk(owner: import("@mysten/sui/client").SuiClientTypes.ObjectOwner): string {
  switch (owner.$kind) {
    case "AddressOwner":
      return `address:${owner.AddressOwner}`;
    case "ObjectOwner":
      return `object:${owner.ObjectOwner}`;
    case "Shared":
      return `shared(initial_version:${owner.Shared.initialSharedVersion})`;
    case "Immutable":
      return "immutable";
    case "ConsensusAddressOwner":
      return `consensus:${owner.ConsensusAddressOwner}`;
    default:
      return "unknown";
  }
}
