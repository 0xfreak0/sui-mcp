import { deepbook, mainnetPools, testnetPools } from "@mysten/deepbook-v3";
import type { PoolMap } from "@mysten/deepbook-v3";
import { SUI_NETWORK } from "../config.js";
import { sui } from "./grpc.js";

const POOLS: PoolMap | null =
  SUI_NETWORK === "mainnet" ? mainnetPools : SUI_NETWORK === "testnet" ? testnetPools : null;

export const deepbookClient = POOLS
  ? sui.$extend(deepbook({ address: "0x0", pools: POOLS }))
  : null;

export const deepbookPools: PoolMap | null = POOLS;
