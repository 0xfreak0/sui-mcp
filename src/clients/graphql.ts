import { GraphQLClient } from "graphql-request";
import { GRAPHQL_URL } from "../config.js";

export const graphqlClient = new GraphQLClient(GRAPHQL_URL);

export async function gqlQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  return graphqlClient.request<T>(query, variables);
}
