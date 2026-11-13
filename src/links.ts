export function isExternalUrl(value: string): boolean {
  return (
    URL.canParse(value) && ["https:", "http:"].includes(new URL(value).protocol)
  );
}
