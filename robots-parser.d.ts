declare module "robots-parser" {
  export default function robotsParser(
    url: string,
    content: string
  ): {
    isAllowed(targetUrl: string, userAgent?: string): boolean | undefined;
  };
}
