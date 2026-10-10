import { describe, expect, it } from "vitest";
import { addressesInPdfText, axelarSuiContracts, layerZeroSuiContracts, mentionsAddress } from "../scripts/lib/disclosure-parse.mjs";

const addr = (byte: string) => `0x${byte.repeat(32)}`;

describe("first-party Sui deployment sources", () => {
  it("uses only the Sui mainnet LayerZero V2 deployment, without duplicating receive ULN", () => {
    const sui = {
      chainKey: "sui", stage: "mainnet", eid: "30378",
      endpointV2: { address: addr("11") },
      executor: { address: addr("22") },
      sendUln302: { address: addr("33") },
      receiveUln302: { address: addr("33") },
    };
    const entries = layerZeroSuiContracts([
      { ...sui, stage: "testnet", endpointV2: { address: addr("aa") } },
      sui,
      { ...sui, chainKey: "ethereum", endpointV2: { address: addr("bb") } },
    ]);
    expect(entries.map((entry: { address: string }) => entry.address)).toEqual([addr("11"), addr("22"), addr("33")]);
    expect(entries.every((entry: { address: string }) => mentionsAddress(JSON.stringify(sui), entry.address))).toBe(true);
    expect(() => layerZeroSuiContracts([{ ...sui, eid: "40378" }])).toThrow();
    expect(() => layerZeroSuiContracts([{ ...sui, executor: { address: "0x2" } }])).toThrow();
  });

  it("requires Axelar's Sui mainnet identity and all three explicitly named contracts", () => {
    const sui = {
      chainType: "sui", networkType: "mainnet", axelarId: "sui",
      contracts: {
        AxelarGateway: { address: addr("11") },
        GasService: { address: addr("22") },
        InterchainTokenService: { address: addr("33") },
        Example: { address: addr("44") },
      },
    };
    const entries = axelarSuiContracts({ chains: { sui } });
    expect(entries.map((entry: { address: string }) => entry.address)).toEqual([addr("11"), addr("22"), addr("33")]);
    expect(() => axelarSuiContracts({ chains: { sui: { ...sui, networkType: "testnet" } } })).toThrow();
    expect(() => axelarSuiContracts({ chains: { sui: { ...sui, contracts: {} } } })).toThrow();
  });
});

describe("proof-of-reserves PDF addresses", () => {
  it("joins Sui addresses broken around the network column, excluding same-shaped Aptos entries", () => {
    const sui = addr("ab");
    const aptos = addr("cd");
    const text = ` Aptos                  ${aptos}\n` +
      `                       ${sui.slice(0, 53)}\n SUI\n` +
      `                       ${sui.slice(53)}\n`;
    expect(addressesInPdfText(text, "sui")).toEqual([sui]);
  });
});
