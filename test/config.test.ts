import { describe, it, expect } from "vitest";
import {
  DEFAULT_NETWORK,
  getNetwork,
  getNetworkConfig,
  getMvrUrl,
  isSuiNetwork,
  runWithNetwork,
  SUI_NETWORKS,
} from "../src/config.js";

describe("isSuiNetwork", () => {
  it("accepts the three known networks", () => {
    expect(isSuiNetwork("mainnet")).toBe(true);
    expect(isSuiNetwork("testnet")).toBe(true);
    expect(isSuiNetwork("devnet")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isSuiNetwork("localnet")).toBe(false);
    expect(isSuiNetwork("MAINNET")).toBe(false);
    expect(isSuiNetwork(undefined)).toBe(false);
    expect(isSuiNetwork(42)).toBe(false);
  });
});

describe("DEFAULT_NETWORK", () => {
  it("defaults to mainnet when SUI_NETWORK is unset in the test env", () => {
    // The suite runs without SUI_NETWORK set, so mainnet is the sane default.
    expect(DEFAULT_NETWORK).toBe("mainnet");
    expect(SUI_NETWORKS).toContain(DEFAULT_NETWORK);
  });
});

describe("getNetwork / runWithNetwork", () => {
  it("returns the default network outside any call context", () => {
    expect(getNetwork()).toBe(DEFAULT_NETWORK);
  });

  it("returns the per-call network inside runWithNetwork", () => {
    const seen = runWithNetwork("testnet", () => getNetwork());
    expect(seen).toBe("testnet");
    // Context does not leak past the call.
    expect(getNetwork()).toBe(DEFAULT_NETWORK);
  });

  it("keeps concurrent async contexts isolated", async () => {
    const testnet = runWithNetwork("testnet", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getNetwork();
    });
    const devnet = runWithNetwork("devnet", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getNetwork();
    });
    expect(await Promise.all([testnet, devnet])).toEqual(["testnet", "devnet"]);
  });
});

describe("getNetworkConfig", () => {
  it("resolves canonical endpoints per network", () => {
    expect(getNetworkConfig("mainnet").fullnode).toBe("https://fullnode.mainnet.sui.io");
    expect(getNetworkConfig("testnet").fullnode).toBe("https://fullnode.testnet.sui.io");
    expect(getNetworkConfig("devnet").fullnode).toBe("https://fullnode.devnet.sui.io");
  });

  it("exposes archive only on mainnet", () => {
    expect(getNetworkConfig("mainnet").archive).toBe("archive.mainnet.sui.io:443");
    expect(getNetworkConfig("testnet").archive).toBeNull();
    expect(getNetworkConfig("devnet").archive).toBeNull();
  });

  it("exposes MVR everywhere except devnet", () => {
    expect(getNetworkConfig("mainnet").mvr).toContain("mvr.mystenlabs.com");
    expect(getNetworkConfig("testnet").mvr).toContain("testnet.mvr.mystenlabs.com");
    expect(getNetworkConfig("devnet").mvr).toBeNull();
  });

  it("defaults to the active call's network", () => {
    const cfg = runWithNetwork("testnet", () => getNetworkConfig());
    expect(cfg.network).toBe("testnet");
    expect(cfg.graphql).toBe("https://graphql.testnet.sui.io/graphql");
  });

  it("getMvrUrl follows the active network", () => {
    expect(runWithNetwork("devnet", () => getMvrUrl())).toBeNull();
    expect(runWithNetwork("testnet", () => getMvrUrl())).toContain("testnet.mvr");
  });
});
