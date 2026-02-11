import { z } from "zod";
import { sui } from "../clients/grpc.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface TokenInfo {
  coin_type: string;
  name: string;
  symbol: string;
  decimals: number;
}

const TOKEN_REGISTRY: TokenInfo[] = [
  { coin_type: "0x2::sui::SUI", name: "Sui", symbol: "SUI", decimals: 9 },
  { coin_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", name: "USD Coin", symbol: "USDC", decimals: 6 },
  { coin_type: "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d9c94a4b9a::usdt::USDT", name: "Tether USD", symbol: "USDT", decimals: 6 },
  { coin_type: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN", name: "Wrapped USDC (Wormhole)", symbol: "wUSDC", decimals: 6 },
  { coin_type: "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX", name: "NAVI Protocol", symbol: "NAVX", decimals: 9 },
  { coin_type: "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS", name: "Cetus", symbol: "CETUS", decimals: 9 },
  { coin_type: "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK", name: "Bucket USD", symbol: "BUCK", decimals: 9 },
  { coin_type: "0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::stsui::STSUI", name: "AlphaFi Staked SUI", symbol: "stSUI", decimals: 9 },
  { coin_type: "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI", name: "Haedal Staked SUI", symbol: "haSUI", decimals: 9 },
  { coin_type: "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI", name: "Aftermath Staked SUI", symbol: "afSUI", decimals: 9 },
  { coin_type: "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT", name: "Volo Staked SUI", symbol: "vSUI", decimals: 9 },
  { coin_type: "0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI", name: "Suilend Staked SUI", symbol: "sSUI", decimals: 9 },
  { coin_type: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP", name: "DeepBook", symbol: "DEEP", decimals: 6 },
  { coin_type: "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA", name: "Scallop", symbol: "SCA", decimals: 9 },
  { coin_type: "0x2053d08c1e2bd02791056171aab0fd12bd7cd484::dsui::DSUI", name: "dSUI", symbol: "dSUI", decimals: 9 },
  { coin_type: "0x5145214a5091f5aa1e1fbade69f01a5b2ada9fc2b2af9e0bde3d3c7e964e8617::blub::BLUB", name: "BLUB", symbol: "BLUB", decimals: 2 },
  { coin_type: "0x76cb819b01abed502bee8a702b4c2d547532c12f25001c9dea795a5e631c26f1::fud::FUD", name: "FUD", symbol: "FUD", decimals: 5 },
  { coin_type: "0xb7844e289a8410e50fb3ca730d5c3c6d0f2d4409a30585a04f0c53a44d53d312::hippo::HIPPO", name: "sudeng HIPPO", symbol: "HIPPO", decimals: 9 },
  { coin_type: "0xa8816d3a6e3136e86bc2873b1f94a15cadc8af2703c075f2d546c2ae367f4df9::ocean::OCEAN", name: "Ocean Protocol", symbol: "OCEAN", decimals: 9 },
  { coin_type: "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN", name: "Wrapped ETH (Wormhole)", symbol: "wETH", decimals: 8 },
  { coin_type: "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN", name: "Wrapped BTC (Wormhole)", symbol: "wBTC", decimals: 8 },
  { coin_type: "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH", name: "Sui Bridge ETH", symbol: "sbETH", decimals: 8 },
  { coin_type: "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e8eb3039c7b4b8254b1a6e65::sswp::SSWP", name: "SuiSwap", symbol: "SSWP", decimals: 9 },
  { coin_type: "0xb848cce11ef3a8f62eccea6eb5b35a12c4c2b1ee1af7755d02d7bd6218e8226f::ns::NS", name: "SuiNS Token", symbol: "NS", decimals: 6 },
  { coin_type: "0xe4239cd951f6c53d9c41e25270d80d31f925ad1655e5ba5b543843d4a66975ee::TURBOS::TURBOS", name: "Turbos Finance", symbol: "TURBOS", decimals: 9 },
];

export function registerTokenSearchTools(server: McpServer) {
  server.tool(
    "search_token",
    "Search for Sui tokens/coins by name or symbol. Returns matching tokens with their full coin type, which can be used with other tools like get_balance or get_coin_info.",
    {
      query: z.string().describe("Search query (e.g. 'USDC', 'SUI', 'staked')"),
      verify_onchain: z
        .boolean()
        .optional()
        .describe(
          "If true, verify each match on-chain and include total supply (default: false)"
        ),
    },
    async ({ query, verify_onchain }) => {
      const q = query.toLowerCase();

      const matches = TOKEN_REGISTRY.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.symbol.toLowerCase().includes(q)
      );

      let results;
      if (verify_onchain) {
        results = await Promise.all(
          matches.map(async (t) => {
            try {
              const { response: res } = await sui.stateService.getCoinInfo({
                coinType: t.coin_type,
              });
              return {
                coin_type: t.coin_type,
                name: t.name,
                symbol: t.symbol,
                decimals: t.decimals,
                total_supply: res.treasury?.totalSupply?.toString() ?? null,
              };
            } catch {
              return {
                coin_type: t.coin_type,
                name: t.name,
                symbol: t.symbol,
                decimals: t.decimals,
                total_supply: null,
              };
            }
          })
        );
      } else {
        results = matches.map((t) => ({
          coin_type: t.coin_type,
          name: t.name,
          symbol: t.symbol,
          decimals: t.decimals,
        }));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                results,
                total_matches: results.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
