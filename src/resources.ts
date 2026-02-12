import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sui } from "./clients/grpc.js";
import { formatOwner } from "./utils/formatting.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAllResources(server: McpServer) {
  // sui://chain/info — current chain status
  server.resource(
    "chain-info",
    "sui://chain/info",
    { description: "Current Sui chain info (chain ID, epoch, checkpoint)" },
    async () => {
      const { response: res } = await sui.ledgerService.getServiceInfo({});
      return {
        contents: [
          {
            uri: "sui://chain/info",
            mimeType: "application/json",
            text: JSON.stringify(
              {
                chain_id: res.chainId,
                epoch: res.epoch?.toString(),
                checkpoint_height: res.checkpointHeight?.toString(),
                timestamp: res.timestamp
                  ? new Date(
                      Number(res.timestamp.seconds) * 1000
                    ).toISOString()
                  : undefined,
                lowest_available_checkpoint: res.lowestAvailableCheckpoint?.toString(),
                lowest_available_checkpoint_objects: res.lowestAvailableCheckpointObjects?.toString(),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // sui://object/{id} — fetch a single object
  server.resource(
    "object",
    new ResourceTemplate("sui://object/{id}", { list: undefined }),
    { description: "Sui object by ID" },
    async (_uri, { id }) => {
      const objectId = Array.isArray(id) ? id[0] : id;
      const { response: res } = await sui.ledgerService.getObject({
        objectId,
        readMask: {
          paths: [
            "object_id", "version", "digest", "object_type",
            "owner", "content",
          ],
        },
      });
      const obj = res.object;
      return {
        contents: [
          {
            uri: `sui://object/${objectId}`,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                object_id: obj?.objectId,
                version: obj?.version?.toString(),
                digest: obj?.digest,
                type: obj?.objectType,
                owner: formatOwner(obj?.owner),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // sui://wallet/{address}/balances — all token balances
  server.resource(
    "wallet-balances",
    new ResourceTemplate("sui://wallet/{address}/balances", { list: undefined }),
    { description: "All token balances for a Sui wallet" },
    async (_uri, { address }) => {
      const addr = Array.isArray(address) ? address[0] : address;
      const res = await sui.listBalances({
        owner: addr,
        limit: 100,
        cursor: null,
      });
      const balances = res.balances.map((b) => ({
        coin_type: b.coinType,
        balance: b.balance,
      }));
      return {
        contents: [
          {
            uri: `sui://wallet/${addr}/balances`,
            mimeType: "application/json",
            text: JSON.stringify({ address: addr, balances }, null, 2),
          },
        ],
      };
    }
  );

  // sui://wallet/{address}/nfts — non-coin objects (NFT-like)
  server.resource(
    "wallet-nfts",
    new ResourceTemplate("sui://wallet/{address}/nfts", { list: undefined }),
    { description: "NFTs and non-coin objects for a Sui wallet" },
    async (_uri, { address }) => {
      const addr = Array.isArray(address) ? address[0] : address;
      const res = await sui.listOwnedObjects({
        owner: addr,
        limit: 50,
      });
      const objects = res.objects
        .filter((o) => !o.type?.includes("::coin::Coin<"))
        .map((o) => ({
          object_id: o.objectId,
          type: o.type,
          version: o.version?.toString(),
        }));
      return {
        contents: [
          {
            uri: `sui://wallet/${addr}/nfts`,
            mimeType: "application/json",
            text: JSON.stringify(
              { address: addr, count: objects.length, objects },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
