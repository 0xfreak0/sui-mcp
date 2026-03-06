import { describe, it, expect } from "vitest";
import {
  registerCollection,
  resolveCollectionType,
  knownSlugs,
  getAllCollections,
} from "../src/discovery-nft.js";

describe("NFT collection registry", () => {
  it("loads static collections from JSON", () => {
    const slugs = knownSlugs();
    expect(slugs).toContain("gawblenz");
    expect(slugs).toContain("doonies");
    expect(slugs).toContain("prime-machin");
    expect(slugs.length).toBeGreaterThanOrEqual(8);
  });

  it("resolves by exact slug", () => {
    const type = resolveCollectionType("gawblenz");
    expect(type).toContain("::gawblenz::Gawblen");
  });

  it("resolves case-insensitive name match", () => {
    const type = resolveCollectionType("Doonies");
    expect(type).toContain("::doonies::NFT");
  });

  it("resolves fuzzy partial match", () => {
    const type = resolveCollectionType("prime");
    expect(type).toContain("::factory::PrimeMachin");
  });

  it("returns null for unknown collection", () => {
    expect(resolveCollectionType("nonexistent-collection-xyz")).toBeNull();
  });

  it("registers new collection at runtime", () => {
    const newType = "0xtest123::mymodule::MyNFT";
    registerCollection(newType);

    const resolved = resolveCollectionType("mymodule");
    expect(resolved).toBe(newType);

    const all = getAllCollections();
    const found = all.find((c) => c.collection_type === newType);
    expect(found).toBeDefined();
    expect(found!.slug).toBe("mymodule");
    expect(found!.name).toBe("MyNFT");
  });

  it("uses custom name when provided", () => {
    const newType = "0xtest456::nftmod::RawStruct";
    registerCollection(newType, "Cool NFTs");

    const all = getAllCollections();
    const found = all.find((c) => c.collection_type === newType);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Cool NFTs");
    expect(found!.slug).toBe("nftmod");
  });

  it("no-ops when registering existing collection", () => {
    const existing = resolveCollectionType("gawblenz")!;
    const countBefore = getAllCollections().length;
    registerCollection(existing, "Should Not Override");
    const countAfter = getAllCollections().length;
    expect(countAfter).toBe(countBefore);

    // Name should not have changed
    const col = getAllCollections().find((c) => c.collection_type === existing);
    expect(col!.name).toBe("Gawblenz");
  });

  it("generates slug with underscores replaced by hyphens", () => {
    const newType = "0xabc::my_cool_module::NFT";
    registerCollection(newType);

    const all = getAllCollections();
    const found = all.find((c) => c.collection_type === newType);
    expect(found!.slug).toBe("my-cool-module");
  });
});
