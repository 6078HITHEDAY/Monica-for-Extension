import type { IdentityItem, BillingAddressItem, CardItem, PaymentAccountItem } from "../core/model";
import type { WalletFillPayload } from "../runtime/messages";
import { profileValues, PROFILE_EXTRAS, ADDRESS_EXTRAS, CARD_NAMES } from "../core/profile-fields";
type WalletItem = IdentityItem | BillingAddressItem | CardItem | PaymentAccountItem;
export function walletPayload(item: WalletItem): WalletFillPayload {
  if (item.kind === "identity") return { kind: item.kind, fields: {
    ...profileValues(item, PROFILE_EXTRAS),
    addressLine3: item.address3, fullName: item.fullName, firstName: item.firstName, middleName: item.middleName, lastName: item.lastName,
    birthDate: item.birthDate, nationality: item.nationality, documentNumber: item.documentNumber, documentType: item.documentType,
    documentIssuedDate: item.issuedDate, documentExpiryDate: item.expiryDate, documentIssuedBy: item.issuedBy,
    passportNumber: item.passportNumber || (item.documentType === "PASSPORT" ? item.documentNumber : undefined),
    licenseNumber: item.licenseNumber || (item.documentType === "DRIVER_LICENSE" ? item.documentNumber : undefined),
    ssn: item.ssn || (item.documentType === "SOCIAL_SECURITY" ? item.documentNumber : undefined), email: item.email, phone: item.phone,
    streetAddress: item.address?.streetAddress, apartment: item.address?.apartment, city: item.address?.city,
    stateProvince: item.address?.stateProvince, postalCode: item.address?.postalCode, country: item.address?.country, company: item.company
  } };
  if (item.kind === "billing-address") return { kind: item.kind, fields: {
    ...profileValues(item, ADDRESS_EXTRAS),
    fullName: item.fullName, company: item.company, streetAddress: item.streetAddress, apartment: item.apartment, city: item.city,
    stateProvince: item.stateProvince, postalCode: item.postalCode, country: item.country, phone: item.phone, email: item.email
  } };
  if (item.kind === "card") return { kind: item.kind, fields: {
    ...profileValues(item, CARD_NAMES),
    cardholderName: item.cardholderName, cardNumber: item.number, cardExpiryMonth: item.expiryMonth, cardExpiryYear: item.expiryYear,
    cardExpiry: [item.expiryMonth, item.expiryYear.length === 4 ? item.expiryYear.slice(-2) : item.expiryYear].filter(Boolean).join("/"),
    cardSecurityCode: item.securityCode, cardBrand: item.brand, cardPin: item.pin, paymentProvider: item.bankName,
    paymentAccountNumber: item.accountNumber, routingNumber: item.routingNumber, iban: item.iban,
    swiftBic: item.swiftBic, branchCode: item.branchCode, currency: item.currency
  } };
  return { kind: item.kind, fields: {
    paymentProvider: item.provider, paymentAccountName: item.accountName, paymentAccountHolder: item.accountHolderName,
    email: item.email, phone: item.phone, paymentUsername: item.username, paymentAccountId: item.accountId,
    paymentAccountNumber: unmaskedAccountNumber(item.maskedAccountNumber), routingNumber: item.routingNumber, iban: item.iban,
    swiftBic: item.swiftBic, currency: item.currency
  } };
}

function unmaskedAccountNumber(value: string): string | undefined {
  const normalized = value.trim();
  return normalized && !/[x*•]/i.test(normalized) ? normalized : undefined;
}
