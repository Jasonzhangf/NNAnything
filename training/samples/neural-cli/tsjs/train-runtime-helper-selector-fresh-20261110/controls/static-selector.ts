type Decoration = "plain" | "bold";

const decorations = {
  plain: (text: string) => text,
  bold: (text: string) => `**${text}**`,
};

function decoratorFor(style: Decoration) {
  return decorations[style];
}

export function decorate(text: string): string {
  return decoratorFor("plain")(text);
}
