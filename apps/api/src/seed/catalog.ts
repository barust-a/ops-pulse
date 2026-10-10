// Reference data the generator draws from: what a mid-size company's IT operations look like.
import type { Priority } from '../domain/incident.js';
import type { Service } from '../domain/service.js';

export const ASSIGNMENT_GROUPS = [
  'Service Desk',
  'Payments Ops',
  'CRM Support',
  'Data Platform SRE',
  'Identity & Access',
  'Network Operations',
  'Reporting & BI',
  'Database Administration',
];

interface ServiceProfile {
  /** Share of the incident volume. */
  share: number;
  group: string;
  categories: readonly string[];
  incidents: readonly string[];
  changes: readonly string[];
}

export const SERVICE_PROFILES: Readonly<Record<Service, ServiceProfile>> = {
  payments: {
    share: 0.2,
    group: 'Payments Ops',
    categories: ['software', 'database', 'network'],
    incidents: [
      'Card authorisation timeouts on checkout',
      'Payment gateway returns HTTP 502 for SEPA transfers',
      'Refund batch stuck in pending state',
      'Duplicate charge reported by a merchant',
      'Settlement file not delivered to the bank',
      '3-D Secure challenge page does not load',
    ],
    changes: [
      'Rotate TLS certificates on the payment gateway',
      'Upgrade the PSP client library',
      'Scale out the authorisation service',
      'Apply the monthly fraud-rule update',
    ],
  },
  crm: {
    share: 0.15,
    group: 'CRM Support',
    categories: ['software', 'access', 'inquiry'],
    incidents: [
      'Customer records fail to sync from the web form',
      'CRM search returns no results for existing accounts',
      'Sales dashboard loads in more than 30 seconds',
      'Email campaign stuck in sending state',
      'Contact import rejects valid CSV files',
    ],
    changes: [
      'Deploy the CRM quarterly release',
      'Add a field to the account layout',
      'Re-index the contact search cluster',
    ],
  },
  'data-platform': {
    share: 0.19,
    group: 'Data Platform SRE',
    categories: ['software', 'database', 'hardware'],
    incidents: [
      'Nightly ETL job failed on the sales mart',
      'Kafka consumer lag above threshold',
      'Data lake storage above 90 % capacity',
      'Dataiku scenario failed: source table missing',
      'Spark executors lost on worker node',
      'Late-arriving data in the daily snapshot',
    ],
    changes: [
      'Upgrade the Kafka brokers',
      'Add a disk to the data lake cluster',
      'Deploy new Dataiku flow version',
      'Patch the Spark worker image',
    ],
  },
  identity: {
    share: 0.15,
    group: 'Identity & Access',
    categories: ['access', 'software'],
    incidents: [
      'SSO login loops back to the identity provider',
      'MFA push notifications delayed',
      'Account locked after password reset',
      'SAML assertion rejected: clock skew',
      'New joiner missing group membership',
    ],
    changes: [
      'Renew the SAML signing certificate',
      'Update conditional access policies',
      'Upgrade the directory sync agent',
    ],
  },
  network: {
    share: 0.17,
    group: 'Network Operations',
    categories: ['network', 'hardware'],
    incidents: [
      'Packet loss between the two data centres',
      'VPN tunnel to the partner site down',
      'Wi-Fi outage on the 3rd floor',
      'DNS resolution slow for internal domains',
      'Firewall cluster failover triggered',
    ],
    changes: [
      'Firmware upgrade on core switches',
      'Add a firewall rule for the partner VPN',
      'Replace the load balancer power supply',
    ],
  },
  reporting: {
    share: 0.14,
    group: 'Reporting & BI',
    categories: ['software', 'database', 'inquiry'],
    incidents: [
      'Monthly KPI report shows empty charts',
      'BI extract refresh timed out',
      'Executive dashboard figures do not match finance',
      'Scheduled report emails not delivered',
    ],
    changes: [
      'Publish the new finance dashboard',
      'Migrate BI extracts to the new warehouse',
      'Update the report scheduler',
    ],
  },
};

export const PRIORITY_MIX: readonly (readonly [Priority, number])[] = [
  [1, 5],
  [2, 15],
  [3, 40],
  [4, 40],
];

/** Median resolution time per priority, in minutes; resolution times are log-normal. */
export const RESOLUTION_MEDIAN_MINUTES: Readonly<Record<Priority, number>> = {
  1: 70,
  2: 190,
  3: 580,
  4: 1700,
};
export const RESOLUTION_SIGMA = 0.75;

/** Relative incident volume per UTC hour: a business-day curve with a quiet night. */
export const HOUR_WEIGHTS: readonly number[] = [
  0.3, 0.25, 0.2, 0.2, 0.25, 0.4, 0.8, 1.6, 3, 3.6, 3.8, 3.6, 3, 3.4, 3.6, 3.4, 3, 2.2, 1.4, 1, 0.8,
  0.6, 0.5, 0.4,
];
