# Configuring Filters

This page is the reference for the Data TA's filters: what each field does, how the rules combine, how to check and change them, and the AWS Lambda filter. When you set up the Data TA for the first time, decide first with [Decide Filtering](decide-filtering.md), and distribute the Data TA with [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md).

### :material-circle-box:{ .taiconcolor } Overview

The Splunk TA for SAP LogServ provides two complementary approaches to filtering LogServ data — you can use either one independently or combine them for defense-in-depth filtering. (A third, lighter layer exists on the Azure and GCP ingest add-ons: their inputs accept optional `include_filters` / `exclude_filters` substring patterns applied to the object path *before download*, a cheap pre-filter — the canonical allow/deny policy still lives on this page's Filters tab.)

| | Native TA Index-Time Filtering | AWS Lambda-Based Filtering |
|---|---|---|
| **Where it runs** | Inside Splunk at index time | In AWS Lambda, before data reaches Splunk |
| **Configured via** | Splunk Web UI (Configuration → Filters) | Lambda environment variables or migration config |
| **Works with** | All deployment scenarios (Connect, Filter, Copy) | S3 Filter and Connect-to-Filter migration only |
| **What it filters** | Raw NDJSON events via TRANSFORMS queue routing | S3 event notifications: the Lambda downloads each object and forwards its notification only if at least one record passes |
| **License impact** | Filtered events consume zero Splunk license | Filtered notifications never reach Splunk |
| **Pattern syntax** | `clz_dir/clz_subdir` wildcard patterns, plus patterns on the event's `source` value (Include Sources / Exclude Sources) | fnmatch patterns on `clz_dir/clz_subdir`, read from each record of the object; no `source` patterns |
| **Time filtering** | Days in the Past: midnight UTC minus N days (epoch regex, refreshed daily) | `DAYS_IN_THE_PAST`: now minus N days, on each record's `_time` |
| **AWS resources needed** | None | Lambda function, local SQS queue, DLQ |
| **Deployment Server support** | ✅ Distributed to heavy forwarders with **Deploy to Forwarders**, after a one-time server-class setup | N/A (AWS-side only) |
| **Upgrade notifications** | ✅ Alerts when new log types aren't covered | ❌ Not available |

<br>

### :material-circle-box:{ .taiconcolor } Which Approach Should I Use?

??? tip "Choosing a filtering approach"
    **Use Native TA filtering (recommended for most users)** if you want the simplest setup — it works with every deployment scenario, requires no AWS resources beyond what you already have, and is managed entirely from Splunk Web. It also provides upgrade notifications when new log types are added to the TA.

    **Use Lambda-based filtering** if you want to reduce what the heavy forwarder downloads and parses, and the SQS messages it handles. Because the Lambda filters S3 event notifications *before* they reach Splunk, the heavy forwarder never downloads the unwanted objects, which lowers its download bandwidth, CPU and ingestion overhead in very high-volume environments. The Lambda itself still downloads every object to check its records, so the total number of S3 GET requests does not fall: it rises by one for each object the Lambda keeps. You also pay for the Lambda's run time and the local SQS queue.

    **Use both together** for defense-in-depth. The Lambda filters at the AWS pipeline level, and the native TA filters catch anything that slips through at the Splunk level. Both match `clz_dir/clz_subdir` folder patterns, but not in quite the same way (see [Lambda Filter Settings](#lambda-filter-settings)): to keep the two aligned, use only patterns the Filters tab accepts. **Include Sources** and **Exclude Sources** have no Lambda equivalent: the Lambda reads only `_time`, `clz_dir` and `clz_subdir` from each record, not its `source`, so file-level rules exist only on the Filters tab.

The remainder of this page covers **Native TA Index-Time Filtering** in detail. For Lambda-based filtering setup, see the [AWS Lambda-Based Filtering](#aws-lambda-based-filtering) section at the bottom of this page or the [AWS Remote S3 Filter Setup Guide](aws-remote-s3-filter-guide.md).

<br>

---

## Native TA Index-Time Filtering

### :material-circle-box:{ .taiconcolor } What It Does

The TA includes built-in **index-time filtering** configured entirely through the Splunk Web UI — no manual editing of configuration files is required.

??? tip "How It Works"
    - **Include Filters** — Folder patterns (`clz_dir/clz_subdir`). Only events matching at least one include pattern — or one Include Sources entry — are eligible for indexing. Everything else is dropped before indexing (zero license cost). An entry of `*/*` or `*` keeps everything.
    - **Exclude Filters** — Folder patterns. Events matching any exclude pattern are dropped, even if they also match an include pattern. Excludes override includes.
    - **Include Sources** — Patterns on the event's whole `source` value (the log file's path, such as `/var/log/zypper.log`, or a name such as `ps`). Keeps matching events even when their folder is not in Include Filters — including events that carry no folder fields at all.
    - **Exclude Sources** — Patterns on the event's `source` value. Drops matching events even when their folder is included — for example the zypper and YaST2 logs that share the `linux/linux_secure` folder with primary log types.
    - **Time Filter (Days in the Past)** — Events with a `_time` older than the configured number of days are dropped. This prevents backfill of very old log data during initial setup or recovery scenarios.

    All filtering happens at index time via TRANSFORMS-based queue routing, so filtered events never consume Splunk license. [How the Rules Combine](#how-the-rules-combine) gives the order in which they are applied.

!!! note "The Filters tab does not reduce heavy forwarder CPU"
    The filter rules run on the heavy forwarder in the same chain of index-time transforms as the Data TA's sourcetype routing, so an event they drop has already been downloaded, split into lines, timestamped and run through that chain. They save license and indexing, not forwarder CPU, and they add rules of their own to the chain. To lower the forwarder's load, drop data before the forwarder downloads it: with the [AWS Lambda pre-filter](#aws-lambda-based-filtering) on AWS, or with the Azure and GCP inputs' path filters. See [Capacity Planning and First Start](../getting-started/capacity-planning.md).

<br>

### :material-circle-box:{ .taiconcolor } Deployment Architectures

The filters run on the instance that parses the data. The TA supports three deployment models, and where you save the filters depends on which one you use.

#### :material-crop-square:{ .taiconcolor } Single Instance or Search Head That Runs the Inputs { #single-instance-search-head }

The TA is installed directly on the instance that parses the data: a single instance, or a search head that runs the LogServ inputs itself ([Running the TAs on a search head](install-ta.md#running-the-tas-on-a-search-head)). Filter changes take effect immediately after clicking Save (no restart required).

#### :material-crop-square:{ .taiconcolor } Deployment Server with Heavy Forwarders

The TA is installed on the Deployment Server (DS) only. The DS distributes the TA and its filter configurations to the heavy forwarders (HFs) that perform the actual data ingestion. This is the recommended architecture when you run several heavy forwarders.

In this model:

- You install and configure the TA on the DS only. A push from the DS replaces each HF's copy of the TA, its `local/` folder included, so do not also install it on the HFs.
- Each Save on the DS stages the generated configurations in `deployment-apps/` for distribution.
- You use the built-in **Deploy to Forwarders** button to push changes to the HFs.
- HFs receive the TA and filter configs at their next phone-home, and then restart.

The first distribution takes one-time steps (the HFs as deployment clients, the server class, its agent assignment): see [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md).

On the DS, the **Deploy to Forwarders** button, and the check that decides whether to show it, need the `edit_deployment_server` capability, not `admin_all_objects`. Splunk Enterprise's `admin` role has it; a custom DS operator role needs it added, or the button does not appear.

#### :material-crop-square:{ .taiconcolor } Heavy Forwarder without a Deployment Server

The TA is installed directly on each heavy forwarder that runs a LogServ input, and no Deployment Server manages it. It works like a single instance:

- Save the Filters (and Cloud Provider) tab on each HF. A Save takes effect on that HF immediately, with no restart, and no **Deploy to Forwarders** button appears.
- With several HFs, save the same values on every one: nothing copies them between HFs.
- The daily Days in the Past refresh rebuilds the rules on the HF itself. If the HF is a deployment client of a DS for other apps, the refresh runs only when the HF's record of what its DS sent (`$SPLUNK_HOME/var/run/serverclass.xml`) lists other apps but not this TA; when that record is missing, unreadable or lists no app, the refresh is skipped, the cutoff stops moving, and the filter keeps more older events each day.

!!! note "Splunk Cloud"
    Splunk Cloud is never a Deployment Server, so the **Deploy to Forwarders** button never appears there. With Splunk Cloud, a DS is optional: run your own on-premises DS to manage your heavy forwarders centrally (your Splunk Cloud subscription includes a deployment server license, which you request from Splunk Support), or install the TA directly on each heavy forwarder.

<br>

### :material-circle-box:{ .taiconcolor } Open the Configuration > Filters Tab

1. In Splunk Web, open the **Splunk TA for SAP LogServ** app
2. Go to **Configuration > Filters**

??? note "Example"
    ![image](../../images/filter-tab-overview.png "Filters Tab Overview")

    On the tab the fields appear in this order: **Enable Filtering**, **Include Filters**, **Exclude Filters**, **Include Sources**, **Exclude Sources**, **Days in the Past**.


### :material-circle-box:{ .taiconcolor } Set Your Filter Options

#### :material-crop-square:{ .taiconcolor } Enable Filtering

Check the **Enable Filtering** checkbox to activate index-time filtering. **Default: unchecked** — out of the box no index-time filtering is applied, and the Include Filters, Exclude Filters, Include Sources, Exclude Sources and Days in the Past values below take effect only once this box is checked. When disabled, all events are indexed without any filtering.

#### :material-crop-square:{ .taiconcolor } Include Filters

Comma-separated patterns specifying which log types to include. Patterns use the format `clz_dir/clz_subdir` with `*` and `?` wildcards:

| Pattern | Meaning |
|---------|---------|
| `*/*` | Include all log types (default) |
| `hana/hanaaudit` | Include only HANA audit logs |
| `linux/*` | Include all Linux log types |
| `linux/messages, hana/*` | Include Linux messages and all HANA logs |
| `dns/*` | Include all DNS log types |

:material-lightning-bolt:{ .taiconcolor } **Rules:**

- Each pattern must be in `dir/subdir` format or a standalone `*`
- An entry of `*/*` or a standalone `*` — anywhere in the list — includes everything: the include gate is left out and the other include entries have no effect (see [Include Everything](#include-everything))
- Valid characters: letters, numbers, `*`, `?`, `.`, `-`, `:`, `_`
- `*` matches any run of characters within its segment and `?` exactly one character: `linux/*` covers every `linux` subfolder, `*/cron` every `cron` subfolder. Matching is case-sensitive
- A folder pattern needs the event's `clz_dir` and `clz_subdir` fields — an event without them matches no folder pattern (see [Events Without Folder Fields](#events-without-folder-fields))
- This field cannot be empty when filtering is enabled — use `*/*` to include everything

??? tip "Supported Log Types Reference"
    See the [Supported Log Types](#supported-log-types) section below for a complete list of `clz_dir/clz_subdir` values you can use in your filter patterns.

#### :material-crop-square:{ .taiconcolor } Exclude Filters

Comma-separated patterns for log types to exclude. Same pattern format as includes. Events matching any exclude pattern are dropped even if they also match an include pattern.

**Example:** To include all Linux logs except cron and slapd:

- Include: `linux/*`
- Exclude: `linux/cron, linux/slapd`

Leave this field empty to exclude nothing. A standalone `*` in Exclude Filters excludes nothing (unlike in Include Filters); `*/*` there drops every event that has folder fields.

#### :material-crop-square:{ .taiconcolor } Include Sources

Comma-separated patterns matched against the event's whole `source` value — see [Source Pattern Syntax](#source-pattern-syntax). An event whose `source` matches an entry is kept even when its folder is not in Include Filters, and even when it carries no folder fields at all. **Default: empty** (none).

- Use it beside an Include Filters allow-list, to keep particular files the allow-list would drop — for example the HANA trace files and Unix command output that real Azure deliveries send without folder fields ([Recipe 4](#recipe-4)).
- It only adds to an allow-list. When Include Filters includes everything (`*/*` or `*`), every event is kept already, and with Enable Filtering checked a save that sets Include Sources is refused because its entries would have no effect.
- Days in the Past and both exclude fields still apply to the events it keeps.

**Example:** Include Filters `hana/hanaaudit, hana/tracelogs`, Include Sources `/usr/sap/*/HDB??/*/trace/*` keeps the HANA audit and trace folders, plus HANA trace files that arrive without folder fields.

#### :material-crop-square:{ .taiconcolor } Exclude Sources

Comma-separated patterns matched against the event's whole `source` value — see [Source Pattern Syntax](#source-pattern-syntax). An event whose `source` matches an entry is dropped, even when its folder is included and even when Include Sources matches it: excludes always win. **Default: empty** (nothing is dropped by source).

- Use it for log files that share a folder with a primary log type — YaST2 and zypper in `linux/linux_secure`, corosync in `linux/pacemaker`. A folder pattern cannot drop them without dropping the primary type too ([Recipe 3](#recipe-3)).
- **Example:** `/var/log/zypper.log*, /var/log/YaST2/*`

!!! warning "A broad source pattern drops primary log types too"
    Exclude Sources acts on every event whose `source` matches, whatever its folder. `/var/log/*` drops `/var/log/messages`, `/var/log/firewall`, `/var/log/cron` and every other file under `/var/log`. Name the files, or limit an entry to one folder (`linux/linux_secure=/var/log/zypper.log*`). The [upgrade notification](#upgrade-notifications) does not read source rules, so a pattern that drops a primary log type raises no banner.

#### :material-crop-square:{ .taiconcolor } Source Pattern Syntax

Both source fields take a comma-separated list. Each entry is either a source pattern on its own, or a folder and a source pattern joined by `=`:

| Entry | Matches |
|---|---|
| `/var/log/zypper.log` | Events whose `source` is exactly `/var/log/zypper.log`, in any folder or none |
| `/var/log/zypper.log*` | The same file and its rotated copies, such as `/var/log/zypper.log-20260823` |
| `/var/log/YaST2/*` | Every file under `/var/log/YaST2/`, subfolders included |
| `ps` | Events whose `source` is `ps` (Unix command output, which carries no folder fields) |
| `/usr/sap/*/HDB??/*/trace/*` | HANA trace files of every SID, instance and host |
| `linux/linux_secure=/var/log/YaST2/*` | YaST2 files, only in the `linux/linux_secure` folder |
| `linux/proxy=/var/log/squid/*` | Squid files, only in the `linux/proxy` folder (the Azure layout) |

:material-lightning-bolt:{ .taiconcolor } **Rules:**

- A pattern must match the **whole** `source` value: `/var/log/zypper` does not match `/var/log/zypper.log`. The value is the one the indexed event carries in its `source` field (one exception: see [Long Lines](#long-lines)). To list the values a folder delivers:

    ```spl
    | tstats count where `sap_logserv_idx_macro` by clz_dir, clz_subdir, source
    ```

- `*` matches any run of characters, **including `/`** — unlike a shell glob, `/var/log/YaST2/*` also covers files in subfolders. `?` matches exactly one character
- Any number of `*` is fine: a pattern is matched in linear time however many it has, and `**` means the same as `*`
- Every other character is literal: `.`, `+`, `-` and `:` have no special meaning
- A pattern is matched against the `source` value as it is written in the event's JSON envelope. Real LogServ `source` values contain no backslash, quote or non-ASCII character; a value that did would be written escaped there (a backslash as `\\`, `é` as `\u00e9`, a quote as `\"`), so a `?` would not stand for one such character — match a backslash or a non-ASCII character with `*` instead. A wildcard never crosses a quote; a pattern that ends in `*` or `?` can still match the part of such a value before its first quote
- Matching is case-sensitive: `/var/log/yast2/*` does not match `/var/log/YaST2/mkinitrd.log`
- A folder entry (`dir/subdir=pattern`) matches only when the folder part and the source pattern both match. The folder part follows the Include Filters rules, except that a standalone `*` is not accepted. Events without folder fields never match a folder entry; a plain entry matches them
- Allowed characters in a source pattern: letters, numbers and `/ . _ : * ? + @ ~ -`. A pattern has at most 512 characters and at least one character that is not `*`, `?` or `/` — patterns that match everything (`*`, `**`, `/*`, `*/*`) are refused: use the folder filters, or turn filtering off
- Not allowed: spaces inside an entry, `"`, `\`, `[`, `]`, a second `=`, control characters and non-ASCII characters. A comma always separates entries. Spaces around entries are ignored; an empty entry (two commas in a row, or a trailing comma) is refused. The whole field is limited to 4,096 characters
- A repeated entry is used once

#### :material-crop-square:{ .taiconcolor } Days in the Past

Whole number (0–3650) specifying the maximum age of events to index. Events whose own `_time` is older than midnight UTC this many days ago are dropped before indexing.

- Set to `7` to only index events from the last 7 days
- Set to `0`, or leave the field empty, to disable time-based filtering
- Default: `7`
- It also limits history loads: with filtering on, the [AWS S3 Direct](aws-s3-direct.md) screen leaves out every day older than the cutoff, because their events would be dropped on arrival. Raise Days in the Past (or set it to `0`) before you load older days.

!!! warning "With a Deployment Server, each heavy forwarder restarts about once a day"
    While Enable Filtering is checked and Days in the Past is above 0, the daily refresh (below) pushes a new cutoff to the heavy forwarders, and each heavy forwarder in the `SAP_LogServ_HeavyForwarders` server class restarts about once a day to apply it, at a time of day set by when the Deployment Server last started. With filtering disabled, or Days in the Past at 0, the refresh changes nothing and no restart follows. On a single instance, or a heavy forwarder without a Deployment Server, the refresh reloads the rules in place, without a restart.

??? tip "How the time filter works"
    The time filter uses a pre-computed epoch-based regex that is refreshed automatically once per day by a built-in scripted input. If the refresh does not run, the cutoff does not move forward and the filter becomes slightly less restrictive: it keeps up to one extra day of older events for each missed day, until the next refresh or Save. The daily refresh rewrites all the generated filter rules, the source rules included, from the saved settings.

    On a Deployment Server the refresh also copies the new rules to `deployment-apps/` and reloads the `SAP_LogServ_HeavyForwarders` server class (only that class), so the heavy forwarders get the new cutoff at their next phone-home. The cutoff changes every day, and the server class the TA creates maps the TA with `restartSplunkd = true`, which is why each heavy forwarder restarts to apply it. The refresh runs when splunkd starts and then once a day. After a Data TA version change on the Deployment Server, it first copies the whole new version into `deployment-apps/`, as a Save would, so the forwarders receive the new version and restart without a Save or **Deploy to Forwarders** ([Later Builds With the Same Version](distribute-data-ta.md#later-builds-with-the-same-version)).

<br>

### :material-circle-box:{ .taiconcolor } How the Rules Combine

The Data TA turns the fields into one chain of index-time transforms. Each step that matches an event decides where it goes — kept for indexing or dropped — and the last step that matched wins:

```
  one NDJSON line (up to 100,000 characters)
    |
    v
  1. Include gate       drop every event                   -+
    |                                                       |  only when Include
    v                                                       |  Filters does not
  2. Include Filters    keep events whose folder matches    |  include everything
    |                                                       |
    v                                                       |
  3. Include Sources    keep events whose source matches   -+
    |
    v
  4. Days in the Past   drop events older than the cutoff
    |
    v
  5. Exclude Filters    drop events whose folder matches
    |
    v
  6. Exclude Sources    drop events whose source matches
    |
    v
  last step that matched: keep -> indexed, drop -> discarded (nullQueue)
  no step matched:        kept
```

In effect, an event is indexed when all of these hold:

- Include Filters includes everything, **or** its folder matches Include Filters, **or** its `source` matches Include Sources
- it is not older than Days in the Past
- its folder matches no Exclude Filters entry
- its `source` matches no Exclude Sources entry

The time filter and both excludes come after the include steps, so they always win. A step whose field is empty is left out of the chain.

#### :material-crop-square:{ .taiconcolor } Include Everything

If any Include Filters entry is `*/*` or a standalone `*`, there is no include gate: steps 1–3 are left out, every event passes them — events without folder fields included — and the other Include Filters entries have no effect. With Enable Filtering checked, a save that also sets Include Sources is refused; a value that reaches the rules anyway (a hand-edited settings file) is ignored, and the Data TA logs a warning. Days in the Past, Exclude Filters and Exclude Sources still apply.

Upgrading from an earlier build? Some filter behaviour on this page changed between builds; see [Upgrading](../getting-started/upgrading.md).

#### :material-crop-square:{ .taiconcolor } Events Without Folder Fields

Not every LogServ event carries `clz_dir` and `clz_subdir`. SAP files some Azure data in a storage folder named `undefined/undefined` (`<prefix>/undefined/undefined/<YYYY>/<MM>/<DD>/`), and its events have neither field. In real Azure deliveries on the reference system that was about 19.9 million events in four weeks, each kind from a single host ([Data Delivered Without Folder Fields](../getting-started/supported-log-types.md#data-delivered-without-folder-fields)):

- the output of Unix commands — about 19.4 million events, with `source` values such as `ps`, `netstat`, `iostat`, `cpu`, `nfsiostat`, `top`, `openPorts`, `interfaces`, `df`, `bandwidth`, `vmstat` and `Unix:ListeningPorts`. They stay under the base `sap_logserv_logs` sourcetype.
- HANA trace directory files, `/usr/sap/<SID>/HDB<nn>/<host>/trace/...` (the `.trc` files and `backup.log`) — about 566,000 events. The Data TA routes them to `sap:hana:tracelogs` by their `source` path ([SAP HANA Trace Logs](../getting-started/supported-log-types.md#sap-hana-trace-logs-logserv-app)); events indexed by an earlier Data TA build keep `sap_logserv_logs`.

Routing does not give an event folder fields, so folder patterns cannot see any of these events, the routed HANA trace files included:

- With Include Filters at `*/*` they are kept.
- With an allow-list — any Include Filters value that does not include everything — **they are all dropped**, unless an Include Sources entry keeps them ([Recipe 4](#recipe-4)). Listing `hana/tracelogs` in Include Filters does not keep the HANA trace files that arrive this way.
- Exclude Filters never drops them: `hana/tracelogs` there leaves these HANA trace files in place. Only Exclude Sources can drop them.
- A folder entry in a source field (`dir/subdir=pattern`) never matches them; a plain source pattern does.
- The [upgrade notification](#upgrade-notifications) reasons about folders only, so it does not point to an allow-list that drops these events. The filter verdict of the LogServ App's [Data Doctor](../logserv-app/dashboards/platform/diagnostics.md#supplying-the-ingest-filter-configuration) for `sap:hana:tracelogs` does take the HANA trace files that arrive this way into account. Wherever it judges that type, it does not treat their arrival as contradicting an Exclude Filters rule on `hana/tracelogs`, and it does not call such a rule a full exclusion. On a HANA Trace panel it also names an allow-list that keeps the `hana/tracelogs` folder but drops these files, as an additional finding listed after the panel's main verdict (such as *Never received* or *Summary not built*), never in its place, because the pasted configuration does not show whether SAP delivers such files to you. A verdict they change is at most *possible*, because the pasted configuration does not show whether your forwarders route these files by their `source` path either. The Data Doctor does not judge the Unix command output, which stays under `sap_logserv_logs`.

:material-lightning-bolt:{ .taiconcolor } **Drop the Unix command output if you do not use it.** It is almost all of this data — about 0.7 million events and roughly 125 MB of text a day on the reference system, about 80% of it `ps` — and the LogServ App does not parse it; it only counts it in its volume dashboards. Exclude Sources `ps, top, netstat, iostat, vmstat, df, cpu, interfaces, bandwidth, openPorts, nfsiostat, Unix:ListeningPorts` drops all twelve wherever they arrive. If you keep them, note that a `ps` row can carry the arguments a process was started with — up to 34% of the real `ps` rows checked on the reference system did — and arguments can contain passwords, keys or tokens.

Before you narrow Include Filters, check what your deliveries carry without folder fields (over a short time range — the search reads raw events):

```spl
`sap_logserv_idx_macro` | where isnull(clz_dir) | stats count by source, sourcetype
```

#### :material-crop-square:{ .taiconcolor } Long Lines

Every rule reads the whole line, up to 100,000 characters — the longest line the Data TA indexes. An index-time transform reads only the first 4,096 characters unless told otherwise, so every filter stanza the Data TA generates sets `LOOKAHEAD = 100000`. This matters for the AWS envelope, which carries the log text (`_raw`) before `source`, `clz_dir` and `clz_subdir`: a rule that read only the first 4,096 characters would miss the folder fields of a long line.

The rules expect the envelope's metadata keys to sit together, all before or all after the `_raw` value, as in every LogServ delivery seen so far (Azure and GCP put them first, AWS after `_raw`). An envelope that put `_raw` between the keys an entry needs would not match that entry: a folder pattern needs `clz_dir` and `clz_subdir`, and a `dir/subdir=` entry also `source`, on the same side of `_raw`. A plain source pattern needs only `source`, so it would still match.

The sourcetype routing and the indexed `host`, `source`, `clz_dir` and `clz_subdir` fields read the same 100,000 characters as the filters. A line longer than 100,000 characters is cut there (`TRUNCATE`), so an AWS line that long loses its envelope keys whatever the rules read.

<br>

### :material-circle-box:{ .taiconcolor } Save

Click **Save**. The TA validates your patterns and generates the necessary configuration files. If there are any validation errors (invalid characters, empty include field, etc.), the save is blocked and an error message is displayed.

Include Sources and Exclude Sources are checked on every save, even with Enable Filtering unchecked, because their values are written to a configuration file either way. For the same reason every field is refused on every save if it contains a line break, a tab or another control character, or ends with a backslash. The folder patterns are checked when Enable Filtering is checked, as before. [Validation Error on Save](#validation-error-on-save) lists the rules.

The rules are generated from the settings as saved. A save through the REST API or the CLI that sends only some of the fields keeps the saved values of the others, so the generated rules always match what the Filters tab shows.

<br>

---

### :material-circle-box:{ .taiconcolor } Deployment Server: Additional Steps

:material-lightning-bolt:{ .taiconcolor } If you are running on a **single instance**, or on a heavy forwarder without a Deployment Server, you can skip this section: filter changes take effect immediately after Save. The first-time steps for a Deployment Server are on [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md).

#### :material-crop-square:{ .taiconcolor } What a Save Does on a Deployment Server { #what-happens-automatically-on-save }

A Save does not send anything to the heavy forwarders by itself. A Save on a Deployment Server copies the TA into `deployment-apps/` the first time (and again after a version change), stages its generated filter and Cloud Provider rules there on every Save, and creates the `SAP_LogServ_HeavyForwarders` server class, disabled, the first time; see [Distribute the Data TA → Save the Configuration Page](distribute-data-ta.md#2-save-the-configuration-page-on-the-deployment-server). The daily filter refresh does reload the server class by itself ([Days in the Past](#days-in-the-past)).

#### :material-crop-square:{ .taiconcolor } Configure the Server Class (First Time Only)

The server class needs an agent assignment that names your heavy forwarders (never `*`); see [Distribute the Data TA → Assign the Heavy Forwarders](distribute-data-ta.md#3-assign-the-heavy-forwarders-to-the-server-class).

#### :material-crop-square:{ .taiconcolor } Deploy to Forwarders

The **Deploy to Forwarders** button pushes the staged configuration; see [Distribute the Data TA → Deploy to Forwarders](distribute-data-ta.md#4-deploy-to-forwarders).

<br>

### :material-circle-box:{ .taiconcolor } Updating Filters on a Deployment Server

Whenever you change filter settings:

1. Make your changes on the Filters tab and click **Save**.
2. Click **Deploy to Forwarders** to distribute the updated configurations. The button reloads every server class on the Deployment Server, not only `SAP_LogServ_HeavyForwarders`.
3. Each heavy forwarder picks up the change at its next phone-home (`phoneHomeIntervalInSecs`, 60 seconds by default) and then restarts. Allow 5 minutes or more before you check **Settings → Forwarder Management**.

A change applies to events parsed after the forwarders receive it. For the first-time setup, see [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md).

!!! note
    With a Deployment Server, install the TA on the Deployment Server only. A push replaces each heavy forwarder's copy of the TA, its `local/` folder included, so anything installed or saved directly on a heavy forwarder in the server class is overwritten.

<br>

---

## Verifying Filters

### :material-circle-box:{ .taiconcolor } Check Included Data Is Arriving

```spl
`sap_logserv_idx_macro` | stats count by clz_dir, clz_subdir
```

You should see data only for log types matching your include patterns.

??? tip "Index macro"
    The `sap_logserv_idx_macro` macro expands to `index="sap_logserv_logs"` by default. It is defined where the Data TA or the LogServ App is installed; on a search head that has neither yet, use `index=sap_logserv_logs` instead. If you changed the index name, follow [Renaming an index](install-ta.md#renaming-an-index): the macro must be changed in every app on the search head that ships it. Or substitute your index name directly in the search.

<br>

### :material-circle-box:{ .taiconcolor } Check Excluded Data Is Not Present

If you configured exclude patterns, verify those log types are absent from search results.

For source rules, list the `source` values per folder over a window that starts after the Save (or, on a Deployment Server, after the forwarders received the change) — events indexed earlier stay in the index:

```spl
| tstats count where `sap_logserv_idx_macro` by clz_dir, clz_subdir, source
```

The files named in Exclude Sources must be gone, while the other files of the same folder still arrive — for `linux/linux_secure`, for example, `/var/log/firewall`, `/var/log/kernel`, `/var/log/sssd/...`, `lastlog` and `who`. `tstats … by clz_dir` leaves out events without folder fields; to check those, use the search in [Events Without Folder Fields](#events-without-folder-fields).

<br>

### :material-circle-box:{ .taiconcolor } Check Time Filtering

Search for events older than your configured cutoff:

```spl
`sap_logserv_idx_macro` earliest=-30d latest=-10d
```

If your Days in the Past is less than 10, this search should return no events indexed after the filter took effect.

<br>

---

## Reading the Active Filter Configuration

Support workflows (and the LogServ App's [Data Doctor](../logserv-app/dashboards/platform/diagnostics.md))
sometimes need the active filter configuration as text. Where to read it:

- **Deployment Server (distributed install), or a single instance:** the Data TA's
  `filter_settings` REST endpoint on that instance. It returns `filter_enabled`,
  `include_filters`, `exclude_filters`, `include_sources`, `exclude_sources` and
  `days_in_past` as saved.
- **Heavy forwarder that no Deployment Server manages:** the same endpoint on that forwarder,
  whose Filters saves are made on it, or its generated `local/transforms.conf`.
- **Heavy forwarder that a Deployment Server manages:** only its generated
  `$SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv/local/transforms.conf`.

The exact commands are in
[Supplying the ingest-filter configuration](../logserv-app/dashboards/platform/diagnostics.md#supplying-the-ingest-filter-configuration).
The LogServ App's **Platform → Diagnostics** page accepts their pasted output and turns the
ingest filters into evidence its missing-data diagnosis can reason about.

!!! warning "The HF's REST endpoint is misleading"
    On a deployment-server-managed heavy forwarder the `filter_settings` REST endpoint
    returns the HF's copy of `local/splunk_ta_sap_logserv_settings.conf` on top of the
    shipped defaults. The Deployment Server copies that file to `deployment-apps/` only
    when it copies the whole TA there: on the first Filters or Cloud Provider save on the
    Deployment Server, and on the first save or daily filter refresh after a TA version
    change. Later saves send only `local/transforms.conf` and `local/props.conf`. So the
    endpoint can show an earlier save's settings, or the shipped defaults, and neither
    tells you what the HF filters now. The active filter is in the generated
    `local/transforms.conf`. Always use the file on an HF that a Deployment Server manages.

!!! note "Source rules make the Data Doctor's folder verdicts approximate"
    A source rule acts on single files, not on whole folders. When a pasted configuration
    has Include Sources or Exclude Sources in effect, the Data Doctor cannot say for certain
    whether a folder's events are kept, and its verdict notes that source rules may drop or
    keep some files of a folder. Its verdict for `sap:hana:tracelogs` also accounts for the
    HANA trace files that arrive without folder fields, which the `hana/tracelogs` folder
    rules do not reach: any Include Filters allow-list drops them unless an Include Sources
    entry without a folder keeps them, and of the exclude rules only Exclude Sources drops
    them. Where those files change the verdict, it reads *Partly excluded?* at no more than
    *possible*: an Exclude Filters rule on `hana/tracelogs` leaves them in place wherever the
    trace type is judged, and on a HANA Trace panel an allow-list that keeps the folder but
    drops them is listed as an additional finding after the panel's main verdict, with
    evidence that explains these files (see
    [Events Without Folder Fields](#events-without-folder-fields)).

!!! tip "The transforms paste also carries the Cloud Provider stamp"
    A pasted `local/transforms.conf` includes the generated `[logserv_set_cloud_provider]`
    stanza when the [Cloud Provider](cloud-attribution.md) dropdown is set,
    so the Data Doctor also records the configured stamp and can explain how it interacts
    with a dashboard's Cloud filter. A missing stanza is *not* read as "Not set" — the paste
    may be truncated; only a settings-conf paste can supply the explicit `not_set` value.

## Supported Log Types

The values to use in filter patterns are the `clz_dir` and `clz_subdir` values each log type arrives with, and for Include Sources and Exclude Sources its `source` values. [Supported Log Types](../getting-started/supported-log-types.md) lists both for every **Primary** log type (those with dedicated sourcetype routing), and the **Secondary** log types, which have no dedicated routing but can still be filtered by their own `clz_dir/clz_subdir` paths, or, where they share a primary type's folder, by their `source` values (see [Filter Recipes](#filter-recipes)).

Real LogServ deliveries do not all use one folder layout: Azure delivers Squid under `linux/proxy` (the AWS bucket uses `proxy/squid`), and GCP delivers `pacemaker.log` under `linux/pacemaker` and a proxy VM's `/var/log/messages` under `linux/proxy`. A rule meant to cover a log type on every cloud names all of its paths. SAP discontinued `abap/dispatcher`, `abap/event` and `abap/workprocess` from LogServ delivery in April 2026, so filters on them affect older data only.

??? tip "Filter pattern examples"
    - To include all DNS logs: `dns/*` or `dns/binddns`
    - To include all Linux logs except cron: Include `linux/*`, Exclude `linux/cron`
    - To exclude Squid on every cloud: Exclude Filters `proxy/squid`, Exclude Sources `linux/proxy=/var/log/squid/*`. Excluding the whole `linux/proxy` folder would also drop the `/var/log/messages` lines a proxy VM delivers there. Likewise, an Include of `linux/*` also keeps Azure's Squid logs
    - To include only HANA audit and web dispatcher logs: `hana/hanaaudit, webdispatcher/accesslog`
    - To include all Windows event logs: `windows/*`
    - To include all ABAP application logs: `abap/*`
    - To include specific ABAP types: `abap/icm, abap/gateway`
    - To include all SAP Cloud Connector logs: `scc/*`
    - To include all SAP service logs: `sap/*`
    - To drop the zypper and YaST2 logs but keep the rest of `linux/linux_secure`: Exclude Sources `/var/log/zypper.log*, /var/log/YaST2/*`
    - To drop zypper's log only where it arrives under `linux/linux_secure`: Exclude Sources `linux/linux_secure=/var/log/zypper.log*` ([Recipe 5](#recipe-5))
    - To keep HANA trace files that arrive without folder fields while Include Filters is an allow-list: Include Sources `/usr/sap/*/HDB??/*/trace/*`
    - Do not drop `/var/log/messages` under `sap/saprouter` as operating-system syslog: there it carries the SAP Router's own records ([Recipe 5](#recipe-5))

<br>

---

## Filter Recipes

Each recipe below is a Filters-tab setting for one goal; several can be combined. Primary log types are routed to their own sourcetypes; Secondary ones stay under the base `sap_logserv_logs` sourcetype ([Supported Log Types](../getting-started/supported-log-types.md#secondary-supported-log-types)), so this search lists the unrouted events by folder and file — the ones these recipes are about:

```spl
| tstats count where `sap_logserv_idx_macro` sourcetype=sap_logserv_logs by clz_dir, clz_subdir, source
```

Enable Filtering must be checked for any recipe to take effect. On a Deployment Server, Save and then **Deploy to Forwarders**; the change applies to events parsed after the forwarders receive it.

### :material-circle-box:{ .taiconcolor } Recipe 1: Allow-list of the Primary Log Types { #recipe-1 }

Keep the folders of the Primary log types and drop every other folder.

- **Include Filters:** `abap/audit, abap/dispatcher, abap/enqueueserver, abap/event, abap/gateway, abap/icm, abap/messageserver, abap/sapstartsrv, abap/workprocess, dns/binddns, hana/hanaaudit, hana/tracelogs, linux/cron, linux/localmessages, linux/messages, linux/linux_secure, linux/pacemaker, linux/proxy, linux/slapd, linux/sudolog, linux/warn, proxy/squid, sap/saphostexec, sap/saprouter, sap/sapstartsrv, scc/audit, scc/tracelogs, webdispatcher/accesslog, windows/*`

The ABAP and Web Dispatcher folders are listed one by one because `abap/*` would also keep the Secondary `abap/transport` and `abap/httpaccess`, and `webdispatcher/*` the Secondary Web Dispatcher traces. `abap/dispatcher`, `abap/event` and `abap/workprocess` stay in the list although SAP discontinued them in April 2026: they keep a backfill of older data, and the Data TA still counts them as supported. Without them, every Save of this list, and every later Data TA upgrade, raises the [upgrade notification](#upgrade-notifications) banner naming the three folders as dropped before indexing; it clears only when they are added.

- **Drops:** every folder not named, including the Secondary folders whose names are not known (Network / Flow, WAF / F5, MSSQL) and any folder a future SAP delivery adds. With this list the upgrade notification stays quiet until a Data TA upgrade adds a Primary log type; it then names the folder to add.
- **Also drops:** every event without folder fields — Unix command output and HANA trace files on Azure (see [Events Without Folder Fields](#events-without-folder-fields)). Add [Recipe 4](#recipe-4) to keep the ones you want.
- **Still keeps:** zypper and YaST2 (they share `linux/linux_secure`) and corosync (it shares `linux/pacemaker`). Add [Recipe 3](#recipe-3).

### :material-circle-box:{ .taiconcolor } Recipe 2: Deny-list of the Secondary Folders { #recipe-2 }

Keep everything except the Secondary folders that have names of their own.

- **Include Filters:** `*/*`
- **Exclude Filters:** `abap/transport, abap/httpaccess, webdispatcher/process, webdispatcher/icm, webdispatcher/sapstartsrv, webdispatcher/devicm, sybase/*, java/*, bobj_bi/*, bobj_bods/*, bobj_sacagent/*, dpagent/*`

The folder names come from the SAP LogServ service description; none of them has appeared in the reference system's real deliveries. Check the folders your own deliveries use with the search above.

- **Keeps:** any folder the list does not name — the Network / Flow, WAF / F5 and MSSQL logs, whose folders are not known, and any folder a future SAP delivery adds. Events without folder fields are kept. With `*/*` the upgrade notification never fires.
- **Still keeps:** zypper, YaST2 and corosync. Add [Recipe 3](#recipe-3).

### :material-circle-box:{ .taiconcolor } Recipe 3: Drop zypper and YaST2, Keep the Rest of linux/linux_secure { #recipe-3 }

zypper and YaST2 write to `linux/linux_secure`, the folder of the Primary firewall, kernel, sssd, `lastlog` and `who` logs. Exclude them by `source`:

- **Exclude Sources:** `/var/log/zypper.log*, /var/log/YaST2/*`

`/var/log/zypper.log*` also covers rotated copies; `/var/log/YaST2/*` covers every YaST2 file, such as `/var/log/YaST2/mkinitrd.log` and `/var/log/YaST2/config_diff_2026_09_28.log` (both seen in real deliveries). To drop them only from that folder, write `linux/linux_secure=/var/log/zypper.log*, linux/linux_secure=/var/log/YaST2/*`.

For corosync in `linux/pacemaker`, add `/var/log/cluster/corosync.log*` — that path is the one the SAP LogServ service description names; corosync has not appeared in the reference system's real deliveries, so check the `source` value your deliveries carry before relying on it.

Combine with Recipe 1 or Recipe 2. Afterwards, the `tstats` search in [Check Excluded Data Is Not Present](#check-excluded-data-is-not-present) must show the other `linux/linux_secure` files still arriving.

### :material-circle-box:{ .taiconcolor } Recipe 4: Keep HANA Trace Files with an Allow-list { #recipe-4 }

An Include Filters allow-list drops every event without folder fields, and real Azure deliveries send HANA trace files without them. Keep them by `source`:

- **Include Filters:** your allow-list, for example Recipe 1's
- **Include Sources:** `/usr/sap/*/HDB??/*/trace/*`

The pattern covers `/usr/sap/<SID>/HDB<nn>/<host>/trace/` and its subfolders for every SID, instance and host. The Data TA routes the `.trc` files and `backup.log` there, and in its `DB_<tenant>/` subfolder, to `sap:hana:tracelogs`; any other file the pattern keeps stays under the base `sap_logserv_logs` sourcetype. To keep the Unix command output too, add the `source` values you want, for example `ps, netstat, iostat, vmstat, df, top`; it stays under `sap_logserv_logs`. Mind the arguments in `ps` rows ([Events Without Folder Fields](#events-without-folder-fields)).

### :material-circle-box:{ .taiconcolor } Recipe 5: Limit a Source Rule to One Folder { #recipe-5 }

A plain source pattern acts in every folder, and on events without folder fields. To make it act in one folder only, write the folder and `=` before it. For example, to drop zypper's log from `linux/linux_secure` and nowhere else:

- **Exclude Sources:** `linux/linux_secure=/var/log/zypper.log*`

The entry matches only events whose folder is `linux/linux_secure` and whose `source` matches `/var/log/zypper.log*`, so a `zypper.log` that a delivery files under another folder is kept. A folder entry never matches an event without folder fields.

!!! warning "Under sap/saprouter, /var/log/messages is SAP Router data"
    On GCP, LogServ files `/var/log/messages` lines under the `sap/saprouter` folder, and the Data TA gives them the `sap:saprouter` sourcetype, so they feed the SAP Router dashboard. On the reference system at least 70% of them, in the one hour measured, were the router's own connection and trace records, and the rest the router container's wrapper output and other text; every line had the same tagged syslog form, and the newest lines carry the router container's tag. An Exclude Sources entry `sap/saprouter=/var/log/messages` drops router records.

<br>

---

## Upgrade Notifications

### :material-circle-box:{ .taiconcolor } How Upgrade Notifications Work

When the TA is upgraded to a new version that supports additional log types, a system message banner appears across all Splunk Web pages if your include filter patterns do not cover the newly supported types. This prevents new log types from being silently dropped.

??? note "Example"
    ![image](../../images/filter-upgrade-banner.png "Upgrade Notification Banner")

To resolve the notification:

1. Open **Configuration → Filters** in the TA
2. Review and update your include patterns to cover the new log types (or use `*/*` to include everything)
3. Save

The banner clears automatically once all supported types are covered.

The same check runs on every Save of the Filters tab with Enable Filtering checked, so an Include Filters list that leaves out a supported folder raises the banner as soon as it is saved, not only after an upgrade.

The check compares the supported folders with Include Filters only. Exclude Filters, Include Sources and Exclude Sources neither raise nor clear the banner, so an exclude that drops a supported log type, or a source rule that drops a primary file, goes unannounced. An Include Filters list with `*/*` or `*` never raises it. It does not know about events without folder fields either: an allow-list that drops the HANA trace files of [Events Without Folder Fields](#events-without-folder-fields) raises no banner, even when it lists `hana/tracelogs`.

<br>

---

## Troubleshooting

### :material-circle-box:{ .taiconcolor } Filters Not Taking Effect (Single Instance)

- Verify filtering is enabled: Check the **Enable Filtering** checkbox
- Check `local/transforms.conf` in the app directory for the generated filter stanzas: `logserv_filter_include_drop`, `logserv_filter_include_allow`, `logserv_filter_include_sources`, `logserv_filter_time_drop`, `logserv_filter_exclude` and `logserv_filter_exclude_sources`, each present only when its field is in use, and each ending in `LOOKAHEAD = 100000`. A long list is split over several stanzas: `logserv_filter_exclude`, `logserv_filter_exclude_2`, and so on
- Check `local/props.conf` for the `TRANSFORMS-00-filter` line under `[sap_logserv_logs]`; it names every generated stanza in the order above
- A source rule matches the whole `source` value and is case-sensitive: compare the entry with the values the folder really delivers (see [Source Pattern Syntax](#source-pattern-syntax))
- Check `_internal` for errors:

```spl
index=_internal sourcetype=splunkd component=PersistentScript splunk_ta_sap_logserv
```

<br>

### :material-circle-box:{ .taiconcolor } Daily Refresh Reports an Invalid Setting

The daily refresh regenerates the filter rules from the saved settings (it runs while Enable Filtering is checked and Days in the Past is above 0). If a saved Include Filters, Exclude Filters, Include Sources or Exclude Sources value breaks the rules for that field — for example after a hand edit of `local/splunk_ta_sap_logserv_settings.conf` — the refresh logs an ERROR and leaves the rules it generated last in place; it never writes a rule built from the invalid value. Find the message with:

```spl
index=_internal sourcetype=splunkd component=ExecProcessor logserv_filter_time_refresh "level=ERROR"
```

Days in the Past is read the same way the Save reads it, so a value the Save accepted is refreshed: `7.0` counts as `7`. A saved value that is not a whole number — such as `7.5`, or text from a hand edit — is reported by the same search: an ERROR that names Days in the Past, and the rules generated last stay in place. Until the value is corrected and saved, the time cutoff does not move forward, so the filter keeps more older events each day.

Open **Configuration → Filters**, correct the field and click **Save**.

<br>

### :material-circle-box:{ .taiconcolor } Filters Not Reaching Heavy Forwarders

- Verify the server class exists and has client targeting configured in **Settings → Forwarder Management**
- Verify deployment-apps has the filter configs:

```bash
cat /opt/splunk/etc/deployment-apps/splunk_ta_sap_logserv/local/transforms.conf
```

- Click **Deploy to Forwarders** and wait for the next phone-home (60 seconds by default) and the restart that follows; allow 5 minutes or more
- If the forwarders still run an older build of the TA, a newer build with the same version number was not copied into `deployment-apps/`: a Save, or the daily filter refresh, copies the whole TA there only the first time and when the version changes. See [Later Builds With the Same Version](distribute-data-ta.md#later-builds-with-the-same-version)
- If only the time cutoff lags behind, check the daily refresh on the Deployment Server: it reloads the server class itself and logs a WARNING when it cannot (the heavy forwarders then keep the previous cutoff until the next **Deploy to Forwarders**):

```spl
index=_internal sourcetype=splunkd component=ExecProcessor logserv_filter_time_refresh "level=WARNING"
```

- Check HF configs:

```bash
cat /opt/splunk/etc/apps/splunk_ta_sap_logserv/local/transforms.conf
```

<br>

### :material-circle-box:{ .taiconcolor } Deployment Server Not Detected

The TA recognises a Deployment Server by its server roles (a server class exists) or by deployment clients that phone home to it; until then a Save does no Deployment Server work and no **Deploy to Forwarders** button appears. Make the heavy forwarders deployment clients first and check that they phone home: see [Distribute the Data TA → Make the Heavy Forwarders Deployment Clients](distribute-data-ta.md#1-make-the-heavy-forwarders-deployment-clients). If they do and the button is still missing, check that your role holds `edit_deployment_server`.

<br>

### :material-circle-box:{ .taiconcolor } Validation Error on Save

- Include patterns must not be empty when filtering is enabled — use `*/*` to include all
- Patterns must use `dir/subdir` format with only valid characters (letters, numbers, `*`, `?`, `.`, `-`, `:`, `_`)
- Days in the Past must be a whole number between 0 and 3650
- Include Sources and Exclude Sources (checked on every save, even with filtering disabled):
    - each entry is a source pattern, or `dir/subdir=` followed by a source pattern
    - a source pattern uses only letters, numbers and `/ . _ : * ? + @ ~ -`, has at most 512 characters, and has at least one character that is not `*`, `?` or `/` — `*`, `**`, `/*` and `*/*` are refused
    - no spaces inside an entry, no `"`, `\`, `[`, `]`, control characters or non-ASCII characters, and only one `=` per entry
    - no empty entries (two commas in a row, or a trailing comma); at most 4,096 characters per field
    - the folder part of a `dir/subdir=` entry follows the Include Filters rules, without a standalone `*`
- With filtering enabled, Include Sources is refused while Include Filters includes everything (`*/*` or `*`): its entries would have no effect — see [Include Everything](#include-everything)
- A single entry whose generated rule would pass 8,000 characters (a very long pattern with many wildcards) is refused; shorten it
- On every save, even with filtering disabled, no field may contain a line break, a tab or another control character, or end with a backslash

<br>

### :material-circle-box:{ .taiconcolor } Time Filter Seems Off by a Day

The time filter epoch cutoff is refreshed once per day by a scripted input. After changing the Days in the Past value, the cutoff regex is regenerated immediately on Save (on a Deployment Server, the forwarders get it after **Deploy to Forwarders**). The cutoff is midnight UTC N days ago, so it moves once a day, not continuously. If the daily refresh does not run, or skips because it cannot read the saved settings (see [Daily Refresh Reports an Invalid Setting](#daily-refresh-reports-an-invalid-setting)), the cutoff stays where it was and the filter becomes slightly less restrictive: it keeps up to one extra day of older events for each missed day, until the next refresh or Save.

<br>

---

## Cloud Provider Attribution

The **Cloud Provider** tab of the Configuration page, the always-on `splunk_solution` stamp and the per-input `cloud_provider` stamps are described on [Choose Cloud Attribution](cloud-attribution.md). In short: leave the dropdown at **Not set** and add `_meta = cloud_provider::aws` to each AWS SQS-Based S3 input; the Azure and GCP inputs and the AWS S3 Direct backfills stamp their own events.

<br>

---

## AWS Lambda-Based Filtering

### :material-circle-box:{ .taiconcolor } Overview

The Lambda-based filtering approach filters S3 event notifications in AWS *before* they reach Splunk. A Lambda function sits between the cross-account SQS queue (in the SAP ECS account) and a local SQS queue (in your Secondary account). For each notification it downloads the object from SAP's bucket, checks the object's records against include/exclude folder patterns and a time cutoff, and forwards only the notifications of objects with at least one wanted record to the local queue that Splunk polls. It is a separate filter from the Filters tab, with settings of its own, and it behaves differently in several ways described below.

??? tip "When to use Lambda-based filtering"
    - You want to reduce what the heavy forwarder downloads and parses (the Lambda reads every object first, so the total number of S3 GET requests does not fall)
    - You want to reduce the SQS messages the heavy forwarder processes
    - You want filtering to happen at the AWS pipeline level as an additional layer

<br>

### :material-circle-box:{ .taiconcolor } How It Works

```
SAP ECS Account                      Your Secondary Account
+--------------+    +-----------+    +------------+    +-----------+
| S3 Bucket    |--->| SQS Queue |--->|   Lambda   |--->| Local SQS |---> Splunk HF
| (LogServ)    |    | (SAP's)   |    |  (filter)  |    |  Queue    |        |
+--------------+    +-----------+    +------------+    +-----------+        |
    ^    ^                             |    |                               |
    |    |   GetObject: every object   |    | drops a notification when no  |
    |    +-----------------------------+    v record passes, or on an error |
    |                                                                       |
    +------------- GetObject: only the objects the Lambda passed ----------+
```

For each notification, the Lambda takes its first S3 record, downloads the object from the SAP ECS bucket (decompressing it if it is gzipped) and reads `_time`, `clz_dir` and `clz_subdir` from each NDJSON record. It forwards the notification, unchanged, as soon as one record passes all three checks:

- the record's `_time` is not older than now minus `DAYS_IN_THE_PAST` days;
- its `clz_dir/clz_subdir` matches an `INCLUDE_FILTERS` pattern;
- it matches no `EXCLUDE_FILTERS` pattern.

If no record passes, it drops the notification. An object that passes is ingested whole: Splunk downloads it and indexes all of its records, older or excluded ones included, unless the Filters tab also drops them. That is why using both together is the safe combination.

!!! warning "The Lambda does not retry: a notification it cannot process is lost"
    When the Lambda cannot read an object from the SAP ECS bucket (for example because SAP's bucket policy is not in place yet), or cannot send the notification to your local queue, it logs the error and reports the message as processed, so SAP's notification is deleted and that object is not ingested. Only an invalid Lambda configuration (a missing or invalid environment variable) returns messages to SAP's queue, even with **Report batch item failures** turned on, and the dead-letter queue the template creates guards your local queue, not SAP's.

    - Before you activate the Lambda's trigger on SAP's queue, wait until SAP confirms that both access policies (S3 and SQS) are in place, and allow about 5 minutes after the stack is created for IAM changes to apply.
    - To find losses, search the Lambda's CloudWatch logs for `Could not retrieve S3 object, discarding message` and `Failed to forward message to target SQS, discarding`.
    - To recover, fix the cause, then load the days the errors cover from the SAP ECS bucket with [AWS S3 Direct](aws-s3-direct.md); the objects stay in SAP's bucket.

<br>

### :material-circle-box:{ .taiconcolor } Setup Options

There are two ways to deploy Lambda-based filtering:

#### :material-crop-square:{ .taiconcolor } New Deployment (S3 Filter Setup)

If you are setting up from scratch, follow the [AWS Remote S3 Filter Setup Guide](aws-remote-s3-filter-guide.md). The CloudFormation template creates the Lambda, the local SQS queue, its dead-letter queue and the IAM resources. You create the bucket for the Lambda code first (its name is yours and must be unique, in the stack's Region) and the access key yourself. You create the Lambda's SQS trigger only after SAP confirms both access policies. See the guide's steps [2](aws-remote-s3-filter-guide.md#2-create-s3-bucket-with-lambda-function-zip-file), [5](aws-remote-s3-filter-guide.md#5-create-access-key-for-iam-user) and [9](aws-remote-s3-filter-guide.md#9-create-the-sqs-queue-trigger).

#### :material-crop-square:{ .taiconcolor } Migration from Existing S3 Connect Deployment

If you already have a working **S3 Connect** deployment and want to add Lambda-based filtering, follow [Legacy: AWS S3 Connect to Filter Migration](https://splunk.github.io/splunk-sap-logserv/content/install-setup/aws-remote-s3-connect-to-filter-migration-guide/) (a legacy guide kept outside the site navigation). The Python migration script adds the Lambda resources to your existing IAM infrastructure without recreating it. For most deployments the native index-time filtering above is the simpler path.

<br>

### :material-circle-box:{ .taiconcolor } Lambda Filter Settings

The Lambda function uses three environment variables for its filter configuration (the Filter template's parameters `DaysInThePast`, `IncludeFilters` and `ExcludeFilters`):

| Variable | Description | Example |
|----------|-------------|---------|
| `DAYS_IN_THE_PAST` | Forward a notification only if at least one of the object's records has a `_time` within this many days: a rolling cutoff, now minus N × 24 hours, recomputed on each run. (The Filters tab uses midnight UTC minus N days, so with the same N the Lambda keeps up to a day less.) 1 to 365 in the CloudFormation template; there is no "0 = off". | `7` |
| `INCLUDE_FILTERS` | Comma-separated fnmatch patterns on `clz_dir/clz_subdir`; a record must match one of them. **An empty value drops every notification**: use `*/*` (the template's default) to include everything. (On the Filters tab an empty Include Filters cannot be saved.) | `linux/*,hana/*` |
| `EXCLUDE_FILTERS` | Comma-separated fnmatch patterns on `clz_dir/clz_subdir` to exclude. Empty excludes nothing. | `linux/cron,linux/slapd` |

:material-lightning-bolt:{ .taiconcolor } If you use both approaches, write the Lambda's patterns only in the form the Filters tab accepts (`dir/subdir` or a standalone `*`, with letters, numbers and `* ? . - : _`), so both match the same records. The Lambda's fnmatch accepts more, and differs: `[...]` character sets work, `*` also matches across `/` (`linux*` matches `linux/cron`), and a bare `*` in `EXCLUDE_FILTERS` drops everything, whereas on the Filters tab it excludes nothing. A record without `_time` never passes. The Lambda reads only `_time`, `clz_dir` and `clz_subdir` from each record, not its `source`, so **Include Sources** and **Exclude Sources** have no Lambda equivalent: file-level rules apply only on the Filters tab.

<br>

### :material-circle-box:{ .taiconcolor } Comparing the Two Approaches Side by Side

Consider a scenario where you want to ingest only `hana/*` and `linux/messages` logs from the last 7 days:

??? tip "Native TA filtering only (simplest)"
    - **Setup:** Configure the Filters tab with include `hana/*, linux/messages` and Days in the Past `7`
    - **What happens:** All S3 objects are downloaded by Splunk, but unwanted events are dropped at index time via TRANSFORMS before consuming license
    - **Pros:** No extra AWS resources, managed from Splunk Web, upgrade notifications, works with any deployment scenario
    - **Cons:** Splunk still downloads and parses all S3 objects before filtering

??? tip "Lambda filtering only"
    - **Setup:** Configure Lambda with the same include/exclude/days patterns
    - **What happens:** The Lambda downloads each object and drops the notifications of objects with no wanted record before Splunk sees them. Splunk downloads only the objects the Lambda passed, and indexes each of them whole
    - **Pros:** Lower forwarder download, CPU and ingestion overhead
    - **Cons:** Requires Lambda + local SQS + DLQ in AWS; the Lambda reads every object, so total S3 GETs rise (Lambda + Splunk), plus Lambda and SQS charges; a passed object's unwanted records are indexed too; a notification the Lambda cannot process is lost; no upgrade notifications; filter changes require updating the Lambda's environment variables

??? tip "Both together (defense-in-depth)"
    - **Setup:** Same patterns configured in both Lambda and the Filters tab
    - **What happens:** Lambda filters at the AWS level first, then native TA filtering drops the unwanted records of the objects the Lambda passed
    - **Pros:** Maximum coverage, safety net if either filter is misconfigured
    - **Cons:** Two places to maintain filter configurations

<br>

## :material-circle-box:{ .cboxmove } Next Steps

- Setting up for the first time: [Decide Filtering](decide-filtering.md), then [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md).
- Connecting your cloud: [Choose Your Cloud and AWS Scenario](choose-your-cloud.md).
- Something not working: [Troubleshooting](../getting-started/troubleshooting.md) and the [Troubleshooting](#troubleshooting) section above.
- Technical internals: [Data TA Internals](../developer/data-ta-internals.md).
