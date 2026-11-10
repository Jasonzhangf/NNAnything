type ThemeName = "paper" | "ink";

const themeRenderers = {
  paper: (value: number) => `paper:${value}`,
  ink: (value: number) => `ink:${value}`,
} satisfies Record<ThemeName, (value: number) => string>;

export function previewTheme(theme: ThemeName, index: number): string {
  return chooseRenderer(theme)(index);
}

function chooseRenderer(theme: ThemeName) {
  return themeRenderers[theme];
}
