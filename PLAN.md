# Omarchy Marketplace Plugins

## Projektziel

Eine offene, statische Marketplace-Website, auf der Entwickler ihre Omarchy-Plugins einreichen und Omarchy-Nutzer vorhandene Plugins entdecken, filtern und installieren können.

Das Projekt orientiert sich:

- visuell an der klaren, technischen Dokumentationssprache von ContextOwl,
- funktional am kuratierten Katalog- und Einreichungsmodell von omarchytheme.com,
- technisch am offiziellen Omarchy-Plugin-Format und dessen `manifest.json`.

Die erste Version benötigt keine Benutzerkonten, keine Datenbank und keinen eigenen Server.

## Bereits getroffene Entscheidungen

| Bereich | Entscheidung |
| --- | --- |
| Architektur | Statische Website und GitHub Actions |
| Einreichung | GitHub-Issue-Template |
| Frontend | Vanilla HTML, CSS und JavaScript |
| Datenquelle | `manifest.json` der einzelnen Plugin-Repositories |
| Registry | Kuratierte `registry.json` mit Repo-URL und Marketplace-Metadaten |
| Hosting | GitHub Pages |
| Veröffentlichung | Erst nach ausdrücklicher Freigabe |

## Leitprinzipien

1. **Einfach betreibbar:** keine Datenbank, keine Accounts und keine laufenden Serverkosten.
2. **Manifest als Quelle:** Plugin-Metadaten werden nicht unnötig doppelt gepflegt.
3. **Kuratiert statt ungeprüft:** neue Plugins werden vor der Aufnahme geprüft.
4. **Command-first:** Installationsbefehle stehen sichtbar im Mittelpunkt.
5. **Schnell und zugänglich:** wenig JavaScript, responsive Bedienung und Tastaturzugänglichkeit.
6. **Transparent:** Herkunft, Lizenz, Aktualität und Prüfstatus eines Plugins sind sichtbar.

## Zielgruppen

### Omarchy-Nutzer

Sie möchten:

- verfügbare Plugins schnell überblicken,
- nach Kategorien und Begriffen suchen,
- Vertrauen anhand von Quelle, Lizenz und Aktualität einschätzen,
- den Installationsbefehl mit einem Klick kopieren.

### Plugin-Entwickler

Sie möchten:

- die Anforderungen an ein Plugin verstehen,
- ihr Repository über ein einfaches Formular einreichen,
- nachvollziehen können, warum eine Einreichung angenommen oder abgelehnt wurde.

### Maintainer

Sie möchten:

- Einreichungen ohne eigenes Admin-Backend prüfen,
- den Katalog über Pull Requests verwalten,
- fehlerhafte oder nicht erreichbare Plugins beim Build erkennen.

## Informationsarchitektur

### 1. Marketplace (`index.html`)

- Kopfbereich mit kurzer Erklärung und primärer Suche
- sichtbarer Installationshinweis im Command-Stil
- Kategorie- und Tag-Filter
- Sortierung nach Name, Aktualität und optional GitHub-Stars
- Plugin-Zähler
- responsives Kartenraster
- Featured- oder Curated-Bereich
- eindeutiger Link zu „Plugin veröffentlichen“
- Hinweis, dass das Projekt nicht offiziell mit Omarchy verbunden ist

### 2. Plugin-Detail (`plugin.html?id=…`)

- Name, Beschreibung, Autor und aktuelle Version
- Installationsbefehl mit Copy-Button
- Kategorie und Tags
- Lizenz, Repository, letzte Aktualisierung und optional Stars
- README-Auszug oder kurze Marketplace-Beschreibung
- Sicherheits- und Vertrauenshinweise
- Link zum Quellcode

Die erste Version rendert diese Seite clientseitig aus `catalog.json`. Vorgerenderte Detailseiten können später für bessere Suchmaschinenindexierung ergänzt werden.

### 3. Plugin veröffentlichen (`publish.html`)

- Voraussetzungen für ein gültiges Plugin
- minimale `manifest.json`-Spezifikation
- Beispielstruktur eines Plugin-Repositories
- lokale Prüfschritte
- Ablauf von Einreichung, Review und Veröffentlichung
- Button zum GitHub-Issue-Formular
- Review-Kriterien und typische Ablehnungsgründe

### 4. Optionale spätere Seiten

- Richtlinien und Moderation
- Änderungsprotokoll
- häufige Fragen
- Kategorienübersicht

## Designsprache

### Visuelle Richtung

- ruhige Developer-Docs-Ästhetik
- viel Weißraum und eine klare typografische Hierarchie
- Monospace-Schrift für Befehle, IDs und technische Metadaten
- gut sichtbare Code-Blöcke mit Copy-Button
- dezente Linien und Flächen statt starker Schatten
- zurückhaltende Akzentfarbe
- Dark und Light Mode über Systempräferenz; manueller Toggle optional

### Kernkomponenten

- Top-Navigation
- Suchfeld
- Filter-Chips oder Select-Filter
- Plugin-Karte
- Command-Block
- Copy-Button mit sichtbarem Erfolgsstatus
- Badge für Kategorie, Lizenz und Curated/Featured
- Empty State ohne Suchtreffer
- Build-/Datenfehlerzustand
- Footer mit Repository-, Einreichungs- und Disclaimer-Link

### Barrierefreiheit

- vollständig per Tastatur bedienbar
- sichtbare Fokuszustände
- ausreichende Farbkontraste
- semantische HTML-Struktur
- verständliche Labels und Statusmeldungen
- Animationen respektieren `prefers-reduced-motion`

## Datenarchitektur

### `registry.json`

Die Registry ist die kuratierte Liste zugelassener Repositories. Sie enthält nur Marketplace-Daten, die nicht zuverlässig aus dem Plugin-Manifest hervorgehen.

```json
{
  "plugins": [
    {
      "repo": "https://github.com/example/omarchy-weather",
      "category": "widgets",
      "tags": ["bar", "weather"],
      "featured": false,
      "addedAt": "2026-07-28"
    }
  ]
}
```

Vorgesehene Regeln:

- `repo` muss eine unterstützte öffentliche Repository-URL sein.
- `category` stammt aus einer kontrollierten Kategorienliste.
- `tags` werden normalisiert und begrenzt.
- `featured` wird ausschließlich von den Maintainern gesetzt.
- `addedAt` wird beim Merge festgelegt.

### `catalog.json`

`catalog.json` wird automatisch erzeugt und nicht manuell gepflegt. Der Build kombiniert:

- Daten aus `registry.json`,
- Plugin-Daten aus `manifest.json`,
- optionale Repository-Metadaten von GitHub,
- abgeleitete Felder wie den Installationsbefehl.

Vorgesehene Felder:

```json
{
  "generatedAt": "2026-07-28T12:00:00Z",
  "plugins": [
    {
      "id": "example.weather",
      "name": "Weather",
      "description": "Weather integration for Omarchy",
      "author": "Example",
      "version": "1.0.0",
      "repo": "https://github.com/example/omarchy-weather",
      "installCommand": "omarchy plugin add https://github.com/example/omarchy-weather.git",
      "category": "widgets",
      "tags": ["bar", "weather"],
      "featured": false,
      "license": "MIT",
      "stars": 42,
      "updatedAt": "2026-07-20T10:00:00Z",
      "previewImage": null
    }
  ],
  "warnings": []
}
```

### Fehlerstrategie

- Ein fehlendes oder ungültiges Manifest erzeugt einen klaren Build-Fehler für neue Einreichungen.
- Bereits gelistete, vorübergehend nicht erreichbare Repositories werden im Build-Bericht markiert.
- Fehlerhafte Einträge dürfen nicht stillschweigend verschwinden.
- Der zuletzt erfolgreiche Katalog soll bei einem fehlgeschlagenen geplanten Refresh online bleiben.
- Externe Inhalte werden beim Rendern nicht als ungeprüftes HTML übernommen.

## Kategorien für Version 1

Die Kategorien werden vor dem MVP final geprüft. Ein schlanker Start:

- Appearance
- Desktop
- Developer Tools
- Hardware
- Productivity
- System
- Widgets
- Other

## Einreichungs- und Review-Ablauf

1. Ein Entwickler öffnet das Issue-Formular „Submit a plugin“.
2. Das Formular fragt Repository-URL, Kategorie, Tags und Bestätigung der Richtlinien ab.
3. Eine GitHub Action prüft mindestens:
   - Repository erreichbar,
   - `manifest.json` im Root vorhanden,
   - erforderliche Felder vorhanden und gültig,
   - Plugin-ID noch nicht vergeben,
   - Installationsquelle verwendet HTTPS,
   - Lizenz und Installationsanweisungen sind auffindbar.
4. Ein Maintainer prüft Zweck, Qualität und erkennbare Risiken.
5. Nach Freigabe wird das Repository per Pull Request in `registry.json` ergänzt.
6. Der Merge startet den Katalog-Build und anschließend das Pages-Deployment.

Für Version 1 wird die Registry nicht automatisch aufgrund eines Issues verändert. Die menschliche Freigabe bleibt erforderlich.

## Sicherheits- und Vertrauensmodell

Ein Marketplace-Eintrag ist keine vollständige Sicherheitsgarantie. Die Website soll das klar kommunizieren.

Mindestmaßnahmen:

- nur HTTPS-Repository-URLs
- keine direkte Ausführung fremden Plugin-Codes während des Website-Builds
- Manifeste und README-Inhalte nur als Daten behandeln
- Größen- und Zeitlimits beim Abruf externer Dateien
- Schema-Validierung und Normalisierung aller Felder
- keine unsichere HTML-Injektion im Frontend
- GitHub Actions auf minimale Berechtigungen begrenzen
- Actions möglichst auf feste Commit-SHAs pinnen
- generierte Daten und Build-Warnungen nachvollziehbar machen
- Meldeweg für schädliche, verlassene oder kompromittierte Plugins

Später möglich:

- sichtbare Review-Stufen
- Prüfdatum und geprüfte Plugin-Version
- automatisierte Warnungen bei archivierten Repositories
- Abhängigkeits- und Installationsskript-Prüfungen

## Preview-Bilder

Empfehlung für den MVP:

1. optionales Preview-Bild aus der Registry,
2. ansonsten GitHub Social Preview,
3. ansonsten generierter typografischer Platzhalter.

Damit ist kein zusätzliches Pflichtfeld im offiziellen Plugin-Manifest nötig. Externe Bilder sollten beim Build validiert oder lokal gespiegelt werden, damit Datenschutz, Stabilität und Layout kontrollierbar bleiben.

## Suche, Filter und Sortierung

Alles läuft im Browser auf Basis von `catalog.json`.

### Suche

Durchsucht:

- Name
- Beschreibung
- Autor
- Plugin-ID
- Kategorie
- Tags

### Filter

- Kategorie
- Tags
- Curated/Featured
- optional Lizenz

### Sortierung

- Featured, danach Name als Standard
- zuletzt aktualisiert
- GitHub-Stars
- alphabetisch

Filterzustand und Suchbegriff sollen später über URL-Parameter teilbar sein.

## Geplante Repo-Struktur

```text
omarchy-plugin-marketplace/
├── PLAN.md
├── README.md
├── LICENSE
├── registry.json
├── package.json
├── site/
│   ├── index.html
│   ├── plugin.html
│   ├── publish.html
│   ├── catalog.json
│   └── assets/
│       ├── css/
│       │   └── style.css
│       ├── js/
│       │   ├── app.js
│       │   ├── plugin.js
│       │   └── theme.js
│       └── img/
├── scripts/
│   ├── build-catalog.mjs
│   └── validate-registry.mjs
└── .github/
    ├── ISSUE_TEMPLATE/
    │   ├── config.yml
    │   └── submit-plugin.yml
    └── workflows/
        ├── validate.yml
        └── deploy.yml
```

`package.json` ist nur für reproduzierbare Build- und Prüfkommandos vorgesehen. Das ausgelieferte Frontend bleibt frameworkfrei.

## GitHub-Actions-Konzept

### `validate.yml`

Auslöser:

- Pull Requests mit Änderungen an Registry, Build-Skripten oder Website
- optional neue Einreichungs-Issues

Aufgaben:

- JSON-Schema prüfen
- doppelte IDs und Repositories erkennen
- Manifeste abrufen und validieren
- Katalog testweise bauen
- HTML-, CSS- und JavaScript-Prüfungen ausführen
- Ergebnis verständlich im Pull Request anzeigen

### `deploy.yml`

Auslöser:

- Merge auf den Hauptbranch
- täglicher geplanter Lauf
- manueller Lauf

Aufgaben:

- Registry validieren
- Katalog reproduzierbar erzeugen
- statische Dateien bündeln
- GitHub-Pages-Artefakt erstellen
- nur nach erfolgreichem Build deployen

## Umsetzungsphasen

### Phase 0 – Grundlagen festlegen

- Projektname und öffentliches Repository festlegen
- Lizenz auswählen
- Kategorien finalisieren
- Preview-Strategie bestätigen
- Manifest-Spezifikation gegen die aktuelle Omarchy-Dokumentation prüfen
- Branding und Disclaimer abstimmen

Ergebnis: bestätigte Produkt- und Datenentscheidungen.

### Phase 1 – Lokaler MVP

- Basisstruktur erstellen
- visuelle Tokens und Kernkomponenten aufbauen
- Marketplace-Seite implementieren
- Suche, Filter, Sortierung und Copy-Button implementieren
- Plugin-Detailseite implementieren
- Publish-Dokumentation erstellen
- lokale Beispiel-Daten für drei bis vier Plugins verwenden

Ergebnis: vollständig lokal nutzbarer Prototyp ohne Veröffentlichung.

### Phase 2 – Registry und Build

- Registry-Schema festlegen
- Manifest- und Repository-Abruf implementieren
- Kataloggenerator mit Fehlerbericht bauen
- Validierungs- und Smoke-Tests ergänzen
- echte Test-Repositories nach Prüfung aufnehmen

Ergebnis: reproduzierbarer `registry.json`-zu-`catalog.json`-Build.

### Phase 3 – Community-Workflow

- Issue-Formular erstellen
- Review-Richtlinien dokumentieren
- Pull-Request-Validierung einrichten
- Moderations- und Meldeprozess dokumentieren

Ergebnis: nachvollziehbare Einreichung ohne eigenes Backend.

### Phase 4 – Veröffentlichung

- öffentliches GitHub-Repository nach Freigabe anlegen
- GitHub Pages konfigurieren
- Deployment-Workflow aktivieren
- Domain und Social Preview optional einrichten
- Production-Smoke-Test durchführen

Ergebnis: öffentlich erreichbarer Marketplace.

### Phase 5 – Ausbau nach realem Bedarf

- statisch vorgerenderte Plugin-Seiten für SEO
- teilbare Filter-URLs
- Collections und „New/Updated“-Bereiche
- Qualitäts- und Vertrauenssignale
- automatische Hinweise bei archivierten oder lange inaktiven Repositories
- optional mehrsprachige Oberfläche

## MVP-Abnahmekriterien

Der lokale MVP ist fertig, wenn:

- die Website auf Desktop und Mobilgeräten verständlich nutzbar ist,
- alle Plugins aus einer lokalen `catalog.json` angezeigt werden,
- Suche, Kategorie-Filter und Sortierung funktionieren,
- der Installationsbefehl zuverlässig kopiert werden kann,
- jedes Plugin eine direkt aufrufbare Detailansicht besitzt,
- die Publish-Seite das Einreichen verständlich erklärt,
- leere Suchergebnisse und Datenfehler sinnvoll dargestellt werden,
- die Oberfläche per Tastatur bedienbar ist,
- keine externen Inhalte als ungeprüftes HTML gerendert werden,
- ein lokaler Build und die vorgesehenen Prüfungen erfolgreich laufen.

Die Build-Pipeline ist fertig, wenn:

- nur gültige Registry-Einträge in den Katalog gelangen,
- doppelte IDs und ungültige URLs den Build stoppen,
- Ausfälle externer Quellen klar protokolliert werden,
- der generierte Katalog deterministisch und nachvollziehbar ist,
- das Deployment nur bei erfolgreicher Validierung startet.

## Nicht Bestandteil der ersten Version

- Benutzerkonten
- Kommentare oder Bewertungen
- direkte Plugin-Uploads
- Zahlungsfunktionen
- eigenes Backend oder eigene Datenbank
- automatische Aufnahme ohne Maintainer-Review
- Ausführung oder Installation eines Plugins durch die Website
- vollständiges Sicherheitsaudit jedes gelisteten Plugins

## Offene Entscheidungen

Vor Beginn des MVP sind diese Punkte zu bestätigen:

1. **Projekt- und Repository-Name:** `omarchy-plugin-marketplace`.
2. **Preview-Strategie:** optionale Registry-URL, GitHub Social Preview und Platzhalter als Fallback.
3. **Detailseiten:** für den MVP clientseitig; später optional statisch vorgerendert.
4. **Lizenz:** beispielsweise MIT für den Website-Code.
5. **Branding:** eigener Name, Logo und Akzentfarbe sowie genaue Formulierung des inoffiziellen Status.
6. **Erste Test-Plugins:** drei bis vier reale, überprüfte Repositories oder ausschließlich lokale Fixtures.

## Unmittelbar nächster Schritt

Nach Freigabe dieses Plans wird Phase 0 abgeschlossen und anschließend der lokale MVP in diesem Projektordner erstellt. Bis zu einer gesonderten Freigabe werden weder ein öffentliches Repository angelegt noch Dateien gepusht oder eine Website veröffentlicht.
