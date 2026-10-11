export function forwardSetCookies(response, setCookies) {
  for (const header of setCookies) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const options = {};

    for (const attribute of attributes) {
      const [rawName, ...rawValue] = attribute.trim().split("=");
      const key = rawName.toLowerCase();
      const attributeValue = rawValue.join("=").trim();

      if (key === "httponly") options.httpOnly = true;
      else if (key === "secure") options.secure = true;
      else if (key === "path" && attributeValue) options.path = attributeValue;
      else if (key === "domain" && attributeValue) options.domain = attributeValue;
      else if (key === "samesite" && ["strict", "lax", "none"].includes(attributeValue.toLowerCase())) {
        options.sameSite = attributeValue.toLowerCase();
      } else if (key === "max-age" && Number.isFinite(Number(attributeValue))) {
        options.maxAge = Number(attributeValue);
      } else if (key === "expires" && attributeValue) {
        const expires = new Date(attributeValue);
        if (!Number.isNaN(expires.getTime())) options.expires = expires;
      }
    }

    response.cookies.set(name, value, options);
  }
}
