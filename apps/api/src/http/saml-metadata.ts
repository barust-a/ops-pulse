const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(value: string): string {
  return value.replaceAll(/["&'<>]/g, (character) => XML_ENTITIES[character] ?? character);
}

/**
 * The SAML 2.0 service-provider metadata an IdP administrator imports to register Ops Pulse:
 * the SP entity id and where the IdP posts its assertions. The assertion consumer endpoint is the
 * extension point a real SSO integration adds; this API does not consume assertions yet.
 */
export function serviceProviderMetadata(sp: { issuer: string; callbackUrl: string }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(sp.issuer)}">`,
    '  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
    '    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>',
    `    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(sp.callbackUrl)}" index="1" isDefault="true"/>`,
    '  </md:SPSSODescriptor>',
    '</md:EntityDescriptor>',
    '',
  ].join('\n');
}
