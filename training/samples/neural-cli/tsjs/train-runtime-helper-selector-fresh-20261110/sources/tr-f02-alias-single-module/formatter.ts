type NumberStyle = "currency" | "percent";

const styles = {
  currency: (amount: number) => `$${amount.toFixed(2)}`,
  percent: (amount: number) => `${(amount * 100).toFixed(1)}%`,
};

function styleFor(style: NumberStyle) {
  return styles[style];
}

export function renderAmount(style: NumberStyle, amount: number): string {
  const chosen = style;
  return styleFor(chosen)(amount);
}
