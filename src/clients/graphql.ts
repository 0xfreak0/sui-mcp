import { GraphQLClient } from "graphql-request";
import { type SuiNetwork, getNetwork, getNetworkConfig } from "../config.js";

// One GraphQL client per network, built on first use and reused thereafter.
const clientCache = new Map<SuiNetwork, GraphQLClient>();

/** Get the GraphQL client for a network (defaults to the current call's network). */
export function getGraphqlClient(network: SuiNetwork = getNetwork()): GraphQLClient {
  let client = clientCache.get(network);
  if (!client) {
    client = new GraphQLClient(getNetworkConfig(network).graphql);
    clientCache.set(network, client);
  }
  return client;
}

/** Run a GraphQL query against the current call's network endpoint. */
export async function gqlQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  return getGraphqlClient().request<T>(query, variables);
}
