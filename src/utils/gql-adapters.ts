import type { GrpcTypes } from "@mysten/sui/grpc";

export interface GqlBalanceChangeNode {
  coinType?: { repr: string };
  amount?: string;
  owner?: { address: string };
}

export interface GqlCommandNode {
  __typename: string;
  function?: {
    name: string;
    module: {
      name: string;
      package: { address: string };
    };
  };
}

export function adaptCommands(nodes: GqlCommandNode[]): GrpcTypes.Command[] {
  const commands: unknown[] = [];

  for (const node of nodes) {
    switch (node.__typename) {
      case "MoveCallCommand":
        commands.push({
          command: {
            oneofKind: "moveCall",
            moveCall: {
              package: node.function?.module.package.address ?? "",
              module: node.function?.module.name ?? "",
              function: node.function?.name ?? "",
              typeArguments: [],
            },
          },
        });
        break;
      case "TransferObjectsCommand":
        commands.push({
          command: {
            oneofKind: "transferObjects",
            transferObjects: {},
          },
        });
        break;
      case "PublishCommand":
        commands.push({
          command: {
            oneofKind: "publish",
            publish: {},
          },
        });
        break;
      case "UpgradeCommand":
        commands.push({
          command: {
            oneofKind: "upgrade",
            upgrade: {},
          },
        });
        break;
      default:
        break;
    }
  }

  return commands as unknown as GrpcTypes.Command[];
}

export function adaptBalanceChanges(nodes: GqlBalanceChangeNode[]): GrpcTypes.BalanceChange[] {
  const changes: unknown[] = nodes.map((node) => ({
    address: node.owner?.address ?? "",
    coinType: node.coinType?.repr ?? "",
    amount: node.amount ?? "0",
  }));

  return changes as unknown as GrpcTypes.BalanceChange[];
}
