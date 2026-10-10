# User guide

Ops Pulse ("Supervision des opérations IT") shows the health of IT services: incidents, changes
and their daily indicators. The interface is in French; labels below are quoted exactly as they
appear on screen.

## Signing in

1. Open the address given by your administrator (demo: <http://localhost:8080>).
2. On the "Connexion" page, enter your "Adresse e-mail" and "Mot de passe", then click
   "Se connecter".
3. Messages you may see:
   - "E-mail ou mot de passe incorrect." — check both fields.
   - "Trop de tentatives. Réessayez dans une minute." — five failed attempts per minute are allowed.
   - "Votre session a expiré. Reconnectez-vous." — sessions last one hour.
4. To leave, open "Compte" and click "Se déconnecter".

Demo environment only (test accounts from the seed, password `OpsPulse!2026`):
`viewer@ops-pulse.test` ("Lecteur"), `analyst@ops-pulse.test` ("Analyste"),
`admin@ops-pulse.test` ("Administrateur").

## Accounts and roles

| Role (on screen)  | Can                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| "Lecteur"         | see every page, filter, open incident details                       |
| "Analyste"        | everything above + "Nouvel incident" and "Mettre à jour" an incident |
| "Administrateur"  | everything above + manage accounts (by the platform team in v0.1)   |

A "Lecteur" sees "Lecture seule : votre rôle ne permet pas de modifier les incidents." in the
incident detail. Ask the platform team (ServiceNow group "Ops Pulse support") for a role change.

## Filters

The "Filtres" bar applies to every page: "Période" (number of days) and "Service". Each page adds
its own filters ("Priorité", "État", "Type", "Recherche"). "Réinitialiser" clears them.

## "Vue d’ensemble" (overview)

Indicator tiles (computed every night by the Dataiku flow, D+1 at 06:00):

| Tile                              | Meaning                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| "Incidents ouverts"               | incidents not resolved yet ("Non résolus à date")                    |
| "MTTR"                            | mean time to resolve ("Temps moyen de résolution")                   |
| "Résolution p90"                  | 90 % of incidents were resolved within this time                     |
| "Taux de dépassement SLA"         | share of resolved incidents that missed their SLA ("Incidents hors délai") |
| "Taux d’échec des changements"    | share of closed changes that failed                                  |
| "Anomalies détectées"             | days × services with an unusual incident volume ("Pics z-score ≥ 3") |

Charts:

- "Volume quotidien d’incidents par service" — one line per service; marked points are anomalies
  (a day far above the previous 28 days).
- "MTTR et dépassement SLA par priorité" — bars: MTTR in hours; line: SLA breach rate.
- "Ouvertures d’incidents par jour et heure" — heatmap of when incidents are opened.
- "Taux d’échec des changements par service".

Every chart has a text summary ("Résumé : …") for screen readers. If the page shows "Aucune donnée
KPI — lancez le flow Dataiku", the nightly computation has not run for the period: contact support.

## "Incidents"

- The table ("Liste des incidents") is sorted by opening date, 25 rows per page ("Page précédente",
  "Page suivante"). Columns: "Numéro", "Description", "Priorité", "État", "Service", "Ouvert le",
  "SLA" ("Dépassé" or "Dans les délais").
- Click a row to open the detail panel: "Catégorie", "Groupe d’affectation", "Résolu le",
  "Échéance SLA", "Causé par le changement". Close it with "Fermer le détail".
- **Analysts:** change the "État" or the "Priorité" and click "Mettre à jour" ("Incident mis à
  jour." confirms). To declare an incident, click "Nouvel incident", fill in "Description courte",
  "Priorité", "Catégorie", "Service", "Groupe d’affectation", then "Créer l’incident".
- Priorities: "P1 — Critique" (SLA 4 h), "P2 — Haute" (8 h), "P3 — Modérée" (24 h), "P4 — Basse" (72 h).

## "Changements"

- "Liste des changements": "Numéro", "Description", "Type", "Risque", "État", "Clôture",
  "Service", "Début prévu".
- "Codes de clôture par service" chart: "Réussi", "Échec", "Retour arrière" for the latest closed
  changes of the period.

## Error messages

| Message                                                  | What to do                                   |
| -------------------------------------------------------- | -------------------------------------------- |
| "Impossible de charger les données" + "Réessayer"        | click "Réessayer"; if it persists, contact support |
| "Le serveur est injoignable. Vérifiez votre connexion."  | network or VPN issue                          |
| "Vous n’avez pas les droits pour cette action."          | your role does not allow it                  |
| "Trop de requêtes. Patientez quelques secondes."         | wait a few seconds                           |

Support: ServiceNow, assignment group "Ops Pulse support".
