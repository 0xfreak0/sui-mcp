import { z } from "zod";
import { addressArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { getNetwork } from "../config.js";
import { describeError, errorResult, isNotFound } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerNameTools(server: McpServer) {
  server.tool(
    "resolve_name",
    "Resolve a SuiNS name (.sui domain) to an address, or reverse-lookup an address to its SuiNS name. Provide 'name' or 'address'. An unregistered, expired or unset name returns a null address with `name_note`; a malformed name is an error.\n\nIDENTITY WARNING: Anyone can buy a SuiNS name. A name matching an exchange, project or person may belong to an unrelated party, including one that wants to mislead an investigator. Treat it as a holder-chosen label, not verified identity; corroborate independently before matching it to identities on other platforms.",
    {
      name: z
        .string()
        .optional()
        .describe("SuiNS name to resolve (e.g. 'example.sui')"),
      address: addressArg()
        .optional()
        .describe("Address to reverse-lookup to a SuiNS name"),
    },
    async ({ name, address }) => {
      if (!name && !address) {
        return errorResult("At least one of 'name' or 'address' must be provided");
      }
      const network = getNetwork();
      const result: Record<string, string | null> = {};
      // SuiNS names are lower-case; the service rejects any other spelling.
      const domain = name?.trim().toLowerCase();

      const forward = domain
        ? sui.nameService.lookupName({ name: domain }).then(
            ({ response }) => {
              result.address = response.record?.targetAddress ?? null;
              if (!result.address) result.name_note = `${domain} is registered but points at no address.`;
              return null;
            },
            (err: unknown) => {
              result.address = null;
              // A failed read is not an unregistered name: only NOT_FOUND and
              // the service's expiry answer say something about the name.
              if (isNotFound(err)) {
                result.name_note = `${domain} is not a registered SuiNS name on ${network}.`;
              } else if (/expired/i.test(describeError(err, network))) {
                result.name_note = `${domain} has expired. An expired name resolves to no address; the last holder may still own the registration NFT.`;
              } else if (err && typeof err === "object" && "code" in err && err.code === "INVALID_ARGUMENT") {
                return `Not a valid SuiNS name: ${describeError(err, network)}`;
              } else {
                result.address_unavailable = `The name lookup failed: ${describeError(err, network)}. This is not evidence the name is unregistered.`;
              }
              return null;
            },
          )
        : Promise.resolve(null);

      const reverse = address
        ? sui.nameService.reverseLookupName({ address }).then(
            ({ response }) => {
              result.name = response.record?.name ?? null;
            },
            (err: unknown) => {
              result.name = null;
              if (!isNotFound(err)) {
                result.name_unavailable = `The reverse lookup failed: ${describeError(err, network)}. This is not evidence the address has no name.`;
              }
            },
          )
        : Promise.resolve();

      const [invalid] = await Promise.all([forward, reverse]);
      if (invalid) return errorResult(invalid);
      const failedAll =
        (!domain || result.address_unavailable !== undefined) && (!address || result.name_unavailable !== undefined);
      if (failedAll) {
        return errorResult(String(result.address_unavailable ?? result.name_unavailable));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );
}
