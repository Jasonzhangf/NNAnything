type BadgeKind = "plain" | "strong";

const badgeDecorators = {
  plain: (value: string) => value,
  strong: (value: string) => `**${value}**`,
} satisfies Record<BadgeKind, (value: string) => string>;

export function decorateBadge(kind: BadgeKind, value: string): string {
  return badgeDecorators[kind](value);
}
