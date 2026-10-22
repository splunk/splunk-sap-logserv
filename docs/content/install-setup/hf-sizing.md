# Heavy Forwarder Sizing

The Data TA does its work where LogServ data is parsed: on the Heavy Forwarders in a distributed deployment, or on the single instance. There every LogServ event passes through the same chain of index-time rules, so the CPU those rules spend per event decides how many events a Heavy Forwarder can take. This page explains what the Data TA does with each event, what that cost was measured at, how to size Heavy Forwarders from a measurement on your own, and what does and does not add capacity.

!!! warning "Update the Data TA first"
    Data TA builds from 0.0.4.1 up to, but not including, **0.1.2 build 1791935359** carry five or six sourcetype routes (six from 0.0.4.2 on) whose cost grows with the square of the line length. With them, the index-time rules cost 2.4 ms of CPU per event on the lab Heavy Forwarder, which limits one pipeline set to about 400 events a second. Builds up to 1791935359 also read only the first 4,096 characters of a line, so long AWS lines lost their routing. Before you size or add hardware, update the Data TA to build 1792189743 or later on every instance that parses LogServ data; see [Version Check](#version-check).

<br>

### :material-circle-box:{ .taiconcolor } What the Data TA Does With Each Event

A Splunk instance handles each event in a fixed series of *pipelines*, linked by queues. Each pipeline runs on one thread. One parsing, merging, typing and index pipeline together form a *pipeline set*; a Heavy Forwarder has one pipeline set unless `parallelIngestionPipelines` says otherwise. The slowest pipeline sets the pace of the whole set: when it cannot keep up, its queue fills and the queues in front of it fill after it.

```
  LogServ object in S3, Azure Blob Storage or Google Cloud Storage
  (gzipped NDJSON, one event per line)
    |
    v
  Input                 Splunk Add-on for AWS (SQS-Based S3), or the LogServ
    |                   Azure / GCP add-on: read the notification, download the
    |                   object, decompress it, hand its lines to Splunk
    v
  [parsingQueue]
    |
    v
  Parsing pipeline      split into lines (LINE_BREAKER), keep lines of up to
    |                   100,000 bytes whole (TRUNCATE)
    v
  [aggQueue]
    |
    v
  Merging pipeline      read the timestamp from the "_time" key
    |
    v
  [typingQueue]
    |
    v
  Typing pipeline       the Data TA's index-time transforms, in order:
    |                   filters (only with Filtering on), host / source /
    |                   folder fields, 34 sourcetype routes, splunk_solution /
    |                   cloud_provider, unwrap "_raw"
    v
  [indexQueue]
    |
    v
  Index pipeline        on a Heavy Forwarder: send the event to the indexers
                        or Splunk Cloud (tcpout); on a single instance: index it
```

The typing pipeline is where the Data TA's rules run, in the `regexreplacement` processor. Splunk tries every rule of the chain on every event, so a route that does not match an event still costs its search:

| Step | Rules | What it does | How its cost grows |
|---|---|---|---|
| Filters | up to 6, only with Filtering on | keep or drop the event ([Configuring Filters](configure-filters.md)) | with the line length |
| Metadata | 3 | set `host` and `source`; write the `clz_dir` and `clz_subdir` fields | with the line length |
| Sourcetype routes | 34 | give the event its sourcetype: 26 routes look for one key and value, such as `"clz_subdir":"dispatcher"` or `"source":"/var/log/cron"`; 1 checks the `source` path of events without folder fields; 7 look for two folder keys, such as `"clz_dir":"abap"` and `"clz_subdir":"audit"` (6 before build 1792189743, which adds the ICM route) | with the line length; the two-key routes with the square of the line length before build 1791935359 |
| Stamps | 2 | write `splunk_solution` and `cloud_provider` | small |
| Unwrap | 1 | keep only the `"_raw"` text of the envelope | with the line length |

From build 1792189743 on, the routes and the metadata rules read up to 100,000 characters of a line, like the filters and the unwrap. Builds up to 1791935359 read the first 4,096 there, so an AWS line longer than about 4 KB (the AWS envelope puts `_raw` first) kept the input's own `host` and `source`, got no folder fields and stayed `sap_logserv_logs`. Lines up to 4,096 characters cost the same with the wider window; a longer line costs each rule a read to its end, in proportion to its length, and is now routed.

The six two-key routes, for `abap/audit`, `abap/sapstartsrv`, `hana/tracelogs`, `scc/audit`, `scc/tracelogs` and `sap/sapstartsrv`, are the ones build 1791935359 changes. Without a `^` at its start, the regex engine tried each of them again at every character of an event it did not match, and each try read to the end of the 4,096-character window. Each route fails to match nearly every event, so all six ran this way on almost every LogServ event. Splunk's regex match limit counts the work of each start position on its own, so it never stopped these searches and nothing was logged. From build 1791935359 on, the six start with `(?s)^` and are tried once per event, with the same routing ([release notes](../overview/release-notes.md#data-ta-six-routing-rules-are-tried-once-per-event-not-at-every-character-build-1791935359-2026-10-13)). Build 1792189743 moves them, and the ICM route, to the filter generator's shape, which stays linear at the 100,000-character window ([release notes](../overview/release-notes.md#data-ta-every-rule-reads-the-whole-line-and-the-icm-route-takes-only-the-abap-folder-build-1792189743-2026-10-16)).

<br>

### :material-circle-box:{ .taiconcolor } Measured Cost

#### :material-crop-square:{ .taiconcolor } Lab Heavy Forwarder, Before Build 1791935359 (Index Time)

These are lab numbers from one Heavy Forwarder and one feed: Splunk 9.4.3, 2 vCPUs, one pipeline set, real SAP LogServ data delivered through Azure Blob Storage and read by the LogServ Azure add-on's queue input, and Data TA builds with the six old routes. The cost per event is CPU time from Splunk's `metrics.log` divided by the LogServ events the forwarder passed on in the same hour, over every hour with at least 10,000 LogServ events.

| | Lab Heavy Forwarder |
|---|---|
| Hours measured | 418 hours between 2026-09-14 and 2026-10-01 |
| LogServ events | 80.0 million, with 84 bytes of event text on average in Splunk's throughput metrics; those count after the unwrap, so the lines the routes read were longer (see the note *The events were short* below) |
| Regex CPU per LogServ event (`regexreplacement`, the Data TA's rules) | median **2.42 ms**, 10th percentile 2.02 ms, 90th percentile 2.93 ms |
| Typing pipeline CPU per LogServ event (all its processors) | median 2.44 ms, 90th percentile 2.94 ms |
| Busiest hour by regex CPU | 1,298 CPU seconds, 36% of one core, at 118 events a second |
| Busiest hour by events | 470,869 events (131 a second), 1,102 CPU seconds |
| Regex CPU in hours without LogServ data | 0.37 CPU seconds an hour (median) |

Both CPU figures count everything the processor or pipeline did in the hour, divided by the LogServ events. On a forwarder that also parses other data with index-time transforms, they are an upper bound for LogServ.

In the busiest hour the typing pipeline used 1,304 CPU seconds, 1,298 of them in `regexreplacement`; the merging pipeline used 28, the index pipeline 6 and the parsing pipeline 2. The Data TA's rules were nearly all of the CPU in the forwarder's pipelines.

At the typing pipeline's median of 2.44 ms per event, one pipeline set runs out of time at about 410 events a second (1 second / 2.44 ms), or about 340 at its 90th-percentile cost of 2.94 ms. That ceiling is arithmetic: averaged over an hour, the lab forwarder's typing pipeline used at most 36% of one core. Over shorter spans it came closer. In the busiest hour it used 0.81 of a core over 5 minutes, and the queues in front of it (typingqueue, aggqueue, parsingqueue) were at times full while the index queue stayed empty ([search 1](#1-which-pipeline-is-busiest), [search 2](#2-which-queue-fills)). The data arrives in bursts, which is why the sizing method below plans for half the ceiling.

The cost per event depends on the log type. Splunk's regex CPU per sourcetype ([search 9](#9-regex-cpu-per-sourcetype-optional)) for the same busiest hour, for the LogServ sourcetypes with more than 1,000 events:

| Sourcetype after routing | Events | Regex CPU per event |
|---|---|---|
| `sap_logserv_logs` (no route matched) | 334,510 | 2.4 ms |
| `linux_messages_syslog` | 32,062 | 6.4 ms |
| `isc:bind:query` | 18,026 | 5.0 ms |
| `sap:sapstartsrv` | 3,722 | 3.6 ms |
| `linux:cron` | 2,056 | 15 ms |
| `linux_secure` | 1,936 | 21 ms |
| `linux:warn` | 1,378 | 62 ms |

In the same hour the cost per event differed by a factor of about 25 between log types, so the mix matters as much as the volume.

:material-lightning-bolt:{ .taiconcolor } **The events were short.** The 84 bytes is the event text after the unwrap, which is what Splunk's throughput metrics count. The routes read the whole NDJSON line, which also carries the envelope keys around `"_raw"` (`_time`, `host`, `source`, `clz_dir`, `clz_subdir` and others); in LogServ sample data they add about 150 characters a line. With the old routes the cost rises steeply with line length. One hour on a second lab Heavy Forwarder, 845 events with 566 bytes of event text on average, came to about 50 ms per event; that is a single hour, so treat it as an indication only. At search time (below), the six old routes alone took 5.8 ms per event on whole lines of about 460 characters and 442 ms on lines of about 4,160. Byte sizes from the throughput metrics do not give the line length the routes read, so measure your forwarder's cost per event with [search 3](#3-cost-per-event-and-capacity-per-pipeline-set) or [search 9](#9-regex-cpu-per-sourcetype-optional) rather than scaling the lab figure by event size.

#### :material-crop-square:{ .taiconcolor } From Build 1791935359 On (Index Time): Not Measured Yet

The update reached the lab Heavy Forwarders on 2026-10-14, and no LogServ data has passed through them since, so there is no fair index-time figure for the new build yet. What is known:

- The update is active: both lab forwarders run build 1791935359 with the six anchored routes.
- Without LogServ data, their regex CPU is unchanged: a median of 0.36 and 0.38 CPU seconds an hour on the two forwarders, against 0.35 and 0.37 before the update.
- At search time, on the same regex library, the anchored routes are 179 to 1,778 times faster than the old ones (below).

How much of the 2.42 ms the update removes on a forwarder has not been measured. Until a measured figure is published here, size from your own measurement after the update; one busy hour is enough ([Measure Your Own Heavy Forwarder](#measure-your-own-heavy-forwarder)).

#### :material-crop-square:{ .taiconcolor } Search Time, Splunk's Own Regex Library

Splunk 9.4.3 uses the same PCRE2 library (10.40) for index-time transforms and for `regex` and `match()` at search time. Measured at search time on generated LogServ events, the six routes cost per event:

| Line length (characters) | Six old routes | Six anchored routes | Anchored routes are faster by |
|---|---|---|---|
| about 460 | 5.8 ms | 0.032 ms | 179 times |
| about 1,160 | 35 ms | 0.073 ms | 485 times |
| about 2,660 | 181 ms | 0.162 ms | 1,120 times |
| about 4,160 | 442 ms | 0.249 ms | 1,778 times |

The anchored routes in this table start with `^`; the shipped `(?s)^` form measured no slower (0.185 ms per event at about 4,160 characters). Every event got the same result from the old and the anchored routes. Search time is not index time: the table shows the direction and how the cost depends on line length, not what the routes cost on your forwarder.

<br>

### :material-circle-box:{ .taiconcolor } Sizing Method

Size from the busiest pipeline's cost per event and your peak arrival rate. For LogServ data the busiest pipeline is normally the typing pipeline; [search 1](#1-which-pipeline-is-busiest) shows whether it is on your forwarder.

1. **Peak arrival rate.** Take the busiest hour of LogServ events and divide by 3,600 to get events a second ([search 5](#5-peak-arrival-rate-at-the-forwarders), or [search 6](#6-peak-rate-before-you-have-a-forwarder) before you have a forwarder).
2. **Cost per event.** Measure the busiest pipeline's CPU per LogServ event at the 90th percentile, in microseconds ([search 3](#3-cost-per-event-and-capacity-per-pipeline-set)).
3. **Ceiling per pipeline set** = 1,000,000 / cost per event, in events a second.
4. **Plan rate per pipeline set** = half the ceiling. The other half absorbs bursts, because the input fetches objects in batches and the rate within an hour is uneven, and the catch-up after an outage or a delivery delay, when the backlog arrives at once.
5. **Plan rate per Heavy Forwarder** = plan rate per pipeline set x pipeline sets: one, or two on a forwarder with spare cores ([Add a Second Pipeline Set](#add-a-second-pipeline-set)).
6. **Heavy Forwarders needed** = peak arrival rate / plan rate per Heavy Forwarder, rounded up. Add one if a forwarder must be able to fail without the others falling behind.

Worked with the lab figures, before the update:

```
  cost per event (typing pipeline, p90)   2,944 microseconds
  ceiling per pipeline set                1,000,000 / 2,944  =  340 events/s
  plan rate per pipeline set              340 / 2            =  170 events/s  (about 0.6 million an hour)
  plan rate per HF, 1 pipeline set                              170 events/s
  plan rate per HF, 2 pipeline sets                             340 events/s  (about 1.2 million an hour)
```

At that cost per event, a feed whose busiest hour carries 12 million events (3,333 events a second) would need 10 Heavy Forwarders with two pipeline sets each. That is why the update comes first.

| Data TA | Cost per event (90th percentile) | Ceiling per pipeline set | Plan rate per pipeline set | Plan rate per HF, 1 set | Plan rate per HF, 2 sets |
|---|---|---|---|---|---|
| Before build 1791935359, lab feed (short events: 84 bytes of event text) | 2.94 ms | 340 events/s | 170 events/s | 170 events/s | 340 events/s |
| Before build 1791935359, longer lines | higher, with the square of the line length | lower | lower | lower | lower |
| Build 1791935359 or later | measure ([search 3](#3-cost-per-event-and-capacity-per-pipeline-set)) | 1,000,000 / cost | half the ceiling | plan rate per set | 2 x plan rate per set |

Your log-type mix and line lengths differ from the lab feed, so measure on your own forwarder, and measure again when the mix changes, for example when log types with long lines are added.

The typing pipeline is not the only limit. The input itself uses CPU outside the pipelines to download and decompress the objects, and the output to the indexers or Splunk Cloud needs network bandwidth. Leave room on the forwarder for the input and the operating system as well.

On a single instance the same chain runs on the instance that also indexes and searches, so the same method applies to its typing pipeline, with less spare CPU around it.

<br>

### :material-circle-box:{ .taiconcolor } Adding Capacity

#### :material-crop-square:{ .taiconcolor } Update the Data TA

Install Data TA build 1792189743 or later on every instance that parses LogServ data: through the Deployment Server for its Heavy Forwarders, directly on a single instance. See [Upgrading to this release](../getting-started/upgrading.md) and [Version Check](#version-check). Then measure again ([search 3](#3-cost-per-event-and-capacity-per-pipeline-set)) before you add hardware.

#### :material-crop-square:{ .taiconcolor } Add a Second Pipeline Set

Each input sends its data through one pipeline set, so a second pipeline set gets work only from a second input. Both are needed:

1. On the Heavy Forwarder, add to `$SPLUNK_HOME/etc/system/local/server.conf` (or a small app of your own) and restart Splunk:

    ```ini
    [general]
    parallelIngestionPipelines = 2
    ```

2. Add a second input that reads the same queue:
    - **AWS:** a second SQS-Based S3 input with the same settings as the first, including the same SQS queue URL and Source Type `sap_logserv_logs` (step 7 of the [AWS Remote S3 Connect Setup Guide](aws-remote-s3-connect-guide.md)). The queue hands each message to one input at a time, so the two inputs share the work.
    - **Azure** and **GCP:** see *Multiple landscapes / fleets* in the [Azure Setup Guide](azure-setup.md#multiple-landscapes-fleets) and the [GCP Setup Guide](gcp-setup.md#multiple-landscapes-fleets), including the at-least-once trade-off of several inputs on one queue or subscription. Those notes are about how fast the input fetches objects: for typical volumes they find one input enough, and suggest a larger `batch_size` or `max_blobs_per_fire` / `max_objects_per_fire`, or a shorter `interval`, before a second input. On a forwarder whose typing pipeline is the limit ([search 1](#1-which-pipeline-is-busiest)) those settings do not help ([What Does Not Add Capacity](#what-does-not-add-capacity)); the second pipeline set gets work only from a second input.

Splunk's guidance is to add a second pipeline set only on a forwarder that is significantly under-utilized, and not to go beyond two without Splunk Professional Services ([Manage pipeline sets](https://help.splunk.com/en/splunk-enterprise/administer/manage-indexers-and-indexer-clusters/9.4/manage-indexes/manage-pipeline-sets-for-index-parallelization)). A pipeline set keeps several threads busy, so check the forwarder's CPU and [search 1](#1-which-pipeline-is-busiest) first. `server.conf` is not part of the Data TA, so a Deployment Server push of the Data TA does not change it.

#### :material-crop-square:{ .taiconcolor } Add Heavy Forwarders on the Same Queue

Forwarders that read the same queue share its messages, so adding a forwarder adds a full set of pipelines. The Splunk Add-on for AWS documents scaling SQS-Based S3 inputs this way ([SQS-Based S3 input](https://splunk.github.io/splunk-add-on-for-amazon-web-services/SQS-basedS3/)). Give each new forwarder the Data TA (through your Deployment Server's server class), the ingest add-on, and the same input or inputs as the first.

```
                              +--> Heavy Forwarder 1
                              |      input A  --> pipeline set 0
                              |      input B  --> pipeline set 1
  one queue  -----------------+
  (SQS queue, Azure Storage   |
   Queue or Pub/Sub           +--> Heavy Forwarder 2
   subscription)                     input A  --> pipeline set 0
                                     input B  --> pipeline set 1
```

<br>

### :material-circle-box:{ .taiconcolor } What Does Not Add Capacity

- **The Data TA's own filters.** The Filters tab saves license and indexing, not forwarder CPU. Its rules run in the typing pipeline as the first steps of the same chain, and the keep-or-drop decision goes to the last filter step that matched, so a dropped event is downloaded, split into lines, timestamped and run through the transforms like any other event before it is discarded. The filters also add rules of their own to the chain ([Configuring Filters](configure-filters.md)).
- **More inputs on one pipeline set.** They download in parallel, but every event still passes through the same typing pipeline thread.
- **More cores alone.** A pipeline is one thread. If the typing pipeline already uses one full core, more cores help only through a second pipeline set or another forwarder.
- **The input's batch size or interval.** They change how fast objects are fetched, not how fast their events are parsed. The Azure and GCP setup guides suggest them before a second input; that advice is for an input that falls behind on fetching, not for a forwarder whose typing pipeline is busy.
- **A smaller `LOOKAHEAD` on the routing rules.** It saves CPU only on lines longer than 4,096 characters, and on AWS those lines would lose their `host`, `source`, folder fields and sourcetype again, as with builds up to 1791935359.

<br>

### :material-circle-box:{ .taiconcolor } What Reduces the Load

Data that never reaches the forwarder costs nothing to parse:

- **AWS: the Lambda pre-filter.** The Lambda drops the notifications of folders you do not want, so the forwarder never downloads those objects and its load falls with the volume. See the [AWS Remote S3 Filter Setup Guide](aws-remote-s3-filter-guide.md) and [Configuring Filters: AWS Lambda-Based Filtering](configure-filters.md#aws-lambda-based-filtering).
- **Azure and GCP: the input's `include_filters` / `exclude_filters`.** They match the object path before the download ([Azure Setup Guide](azure-setup.md#configure-the-input), [GCP Setup Guide](gcp-setup.md#configure-the-input)).
- **Log types you do not use, left out at the source.** Where your SAP LogServ subscription lets you choose the log types delivered, leave out the ones you do not need. [Search 7](#7-log-type-mix) shows which log types make up your volume.

<br>

### :material-circle-box:{ .taiconcolor } Measure Your Own Heavy Forwarder

Run these searches from a search head that sees the forwarder's `_internal` data; forwarders send it by default. Replace `<HF>` with the forwarder's host name as it appears in `_internal`, and `sap_logserv_logs` with your index name if you renamed it. Use a time range with busy LogServ hours: one busy hour for searches 1, 2, 4 and 9, the last 7 days for searches 3 and 5. `_internal` usually keeps about 30 days. All of them are read-only.

#### :material-crop-square:{ .taiconcolor } 1. Which Pipeline Is Busiest

CPU per pipeline thread, in cores, in 5-minute steps. A pipeline near **1.0** is saturated, however many cores the forwarder has.

```spl
index=_internal host=<HF> source=*metrics.log* group=pipeline
| eval pipeline=name.":".coalesce(ingest_pipe, "0")
| timechart span=5m per_second(cpu_seconds) by pipeline
```

The number after the colon is the pipeline set: `typing:0`, `typing:1` and so on.

#### :material-crop-square:{ .taiconcolor } 2. Which Queue Fills

```spl
index=_internal host=<HF> source=*metrics.log* group=queue
| eval fill_pct=round(100*coalesce(current_size_kb/max_size_kb, current_size/max_size), 1)
| timechart span=5m perc90(fill_pct) by name
```

The pipeline queues report their size in KB and the output queue in bytes; the `coalesce` covers both, so the output queue gets a column too.

Events flow parsingqueue, aggqueue, typingqueue, indexqueue, then the output queue (`tcpout_*`). The bottleneck is the last queue in that order that is full. A full typingqueue with a mostly empty indexqueue points at the index-time transforms; a full indexqueue or output queue points at the output to the indexers or Splunk Cloud.

#### :material-crop-square:{ .taiconcolor } 3. Cost per Event and Capacity per Pipeline Set

The CPU of the typing pipeline (and of its `regexreplacement` processor, which runs the Data TA's rules) per LogServ event, over the hours with at least 10,000 LogServ events, and the rates of the [Sizing Method](#sizing-method) from it:

```spl
index=_internal host=<HF> source=*metrics.log*
    ((group=per_index_thruput series=sap_logserv_logs) OR (group=pipeline name=typing))
| bin _time span=1h
| eval typing_cpu=if(group="pipeline", cpu_seconds, null()),
       regex_cpu=if(group="pipeline" AND processor="regexreplacement", cpu_seconds, null()),
       logserv_ev=if(group="per_index_thruput", ev, null())
| stats sum(typing_cpu) as typing_cpu_s, sum(regex_cpu) as regex_cpu_s, sum(logserv_ev) as logserv_events by _time
| where logserv_events>=10000
| eval typing_us=typing_cpu_s*1000000/logserv_events, regex_us=regex_cpu_s*1000000/logserv_events
| stats count as busy_hours, sum(logserv_events) as logserv_events,
        median(regex_us) as regex_median_us, perc90(regex_us) as regex_p90_us,
        median(typing_us) as typing_median_us, perc90(typing_us) as typing_p90_us,
        max(typing_cpu_s) as typing_peak_cpu_s_in_an_hour
| eval ceiling_eps_per_set=round(1000000/typing_p90_us, 0), plan_eps_per_set=round(500000/typing_p90_us, 0),
       typing_peak_pct_of_one_core=round(100*typing_peak_cpu_s_in_an_hour/3600, 1)
| foreach *_us [ eval <<FIELD>>=round('<<FIELD>>', 1) ]
```

- `typing_p90_us` is the cost per event of step 2 of the sizing method; `ceiling_eps_per_set` and `plan_eps_per_set` are steps 3 and 4.
- `regex_median_us` and `regex_p90_us` are the figures in the lab table above.
- On a forwarder that also parses other data, the CPU includes that data, so the cost per LogServ event is an upper bound.
- Splunk writes `per_index_thruput` (and `per_sourcetype_regex_cpu`, search 9) only for the busiest series of each metrics sample: `maxseries` in the `[metrics]` stanza of `limits.conf`, 10 by default. On a forwarder that writes to many indexes, a sample that leaves out `sap_logserv_logs` makes the search count too few LogServ events, and so overstate the cost per event.
- With two pipeline sets the search adds up both sets. The cost per event stays right; `typing_peak_pct_of_one_core` is then for both sets together.
- If search 1 shows another pipeline as the busiest, replace `name=typing` with its name.
- After an update of the Data TA, run it once over hours before the update and once over hours after it, and compare.

#### :material-crop-square:{ .taiconcolor } 4. Where the CPU Goes, by Processor

```spl
index=_internal host=<HF> source=*metrics.log* group=pipeline
| stats sum(cpu_seconds) as cpu_s by name processor
| addinfo
| eval avg_cores=round(cpu_s/(info_max_time-info_min_time), 3)
| sort - cpu_s
| head 15
```

Run it over a fixed time range, such as one busy hour. `name=typing processor=regexreplacement` is the Data TA's rules; `name=merging processor=aggregator` is the timestamp; `name=parsing processor=linebreaker` is the line breaking.

#### :material-crop-square:{ .taiconcolor } 5. Peak Arrival Rate at the Forwarders

```spl
index=_internal source=*metrics.log* group=per_index_thruput series=sap_logserv_logs host IN (<HF1>, <HF2>)
| bin _time span=1h
| stats sum(ev) as events by _time
| stats max(events) as peak_events_hour, median(events) as median_events_hour
| eval peak_events_per_s=round(peak_events_hour/3600, 0), median_events_per_s=round(median_events_hour/3600, 0)
```

List every forwarder that reads LogServ data. The median counts only hours with LogServ data. The same top-series limit as in search 3 applies: on a forwarder with many indexes the counts can come out low.

#### :material-crop-square:{ .taiconcolor } 6. Peak Rate Before You Have a Forwarder

If the data already arrives somewhere, for example on a test forwarder or under another sourcetype, count it by hour in the index instead (replace the macro with `index=<your index>` if the data is in another index):

```spl
| tstats count where `sap_logserv_idx_macro` earliest=-7d@h latest=@h by _time span=1h
| stats max(count) as peak_events_hour, median(count) as median_events_hour
| eval peak_events_per_s=round(peak_events_hour/3600, 0)
```

This counts by event time, not arrival time, so it smooths out delivery bursts; keep the headroom of step 4.

#### :material-crop-square:{ .taiconcolor } 7. Log-Type Mix

```spl
| tstats fillnull_value="(none)" count where `sap_logserv_idx_macro` earliest=-24h by sourcetype, clz_dir, clz_subdir
| sort - count
| head 20
```

The folders with the most events are the first to consider for the Lambda pre-filter or for leaving out at the source. The folder fields exist on data the Data TA has parsed; events without them show as `(none)`.

#### :material-crop-square:{ .taiconcolor } 8. Parsing Warnings and Errors

```spl
index=_internal host=<HF> sourcetype=splunkd (log_level=WARN OR log_level=ERROR)
    (component=DateParserVerbose OR component=LineBreakingProcessor OR component=AggregatorMiningProcessor OR component=regexExtractionProcessor OR component=Regex)
| timechart span=15m count by component
```

Each warning is CPU and log volume too. `PCRE_ERROR_DEPTHLIMIT` errors, or lines truncated at 10,000 bytes, mean a Data TA without the long-line fix of 0.1.2 ([release notes](../overview/release-notes.md#data-ta-long-ndjson-lines-are-unwrapped-and-kept-whole-2026-09-24)).

#### :material-crop-square:{ .taiconcolor } 9. Regex CPU per Sourcetype (Optional)

```spl
index=_internal host=<HF> source=*metrics.log* group=per_sourcetype_regex_cpu
| stats sum(cpu) as cpu_ms, sum(ev) as events by series
| eval ms_per_event=round(cpu_ms/events, 2)
| sort - cpu_ms
```

Splunk reports `cpu` in milliseconds; across all series it comes to about the `regexreplacement` CPU of search 4. Events count under the sourcetype they end up with, so add up `sap_logserv_logs` and the sourcetypes the Data TA routes to. This group, too, lists only the busiest series of each sample (`maxseries`, 10 by default), so its totals can fall short of search 3: in the lab's busiest hour its LogServ sourcetypes added up to 394,452 events, against 423,531 in `per_index_thruput`, about 7% fewer. Splunk reports this group only where `regex_cpu_profiling` is on; the lab's Splunk 9.4.3 forwarders report it with nothing set in `limits.conf`. If it returns nothing, use search 3.

<br>

### :material-circle-box:{ .taiconcolor } Version Check

| Data TA | The two-key routes |
|---|---|
| 0.1.2 build 1792189743 and later | seven, in the filter generator's shape with a 100,000-character window: linear, the whole line |
| 0.1.2 build 1791935359 | six, anchored with `(?s)^`: tried once per event, first 4,096 characters |
| 0.1.2 builds before 1791935359, 0.1.1, 0.0.6, 0.0.5.x, 0.0.4.2 | unanchored: tried at every character |
| 0.0.4.1 | five of them, unanchored |
| 0.0.3.x | none |

Check on each Heavy Forwarder, or on the single instance, not only on the Deployment Server: the forwarders are where the rules run.

The installed version and build:

```bash
grep -E "^(version|build)" $SPLUNK_HOME/etc/apps/splunk_ta_sap_logserv/default/app.conf
```

The routing-cost fix is in place with `version = 0.1.2` and `build = 1791935359` or higher, the 100,000-character window with `build = 1792189743` or higher. In Splunk Web on the forwarder, the same from a search:

```spl
| rest /services/apps/local splunk_server=local
| search title=splunk_ta_sap_logserv
| table title version build
```

The rules in effect, including any `local/` override:

```bash
$SPLUNK_HOME/bin/splunk btool transforms list | grep -cF '(?=.*"clz_dir"'
$SPLUNK_HOME/bin/splunk btool transforms list set_srctype_abap_icm | grep -E '^(REGEX|LOOKAHEAD)'
```

The first command prints the number of routes still in an older two-key form, `(?s)^(?=.*...)` or unanchored: **0** after the update to build 1792189743. The second shows the ICM route in the generator's shape and `LOOKAHEAD = 100000`.

!!! warning "Remove a local override of the routes before you update"
    If you added the six anchored routes (`(?s)^(?=.*...)(?=.*...)`) to the Data TA's `local/transforms.conf` as a test, remove them, and restart Splunk, before you install build 1792189743. `local/` wins over `default/` key by key, so the old REGEX would stay in effect together with the build's new `LOOKAHEAD = 100000`, and on lines near 100,000 characters that combination exceeds Splunk's regex match limit. The first command above prints **0** when no such override is left.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

- [Installing the Data TA](install-ta.md) and [Upgrading to this release](../getting-started/upgrading.md)
- [Configuring Filters](configure-filters.md), including [AWS Lambda-Based Filtering](configure-filters.md#aws-lambda-based-filtering)
- [AWS Remote S3 Connect Setup Guide](aws-remote-s3-connect-guide.md) and [AWS Remote S3 Filter Setup Guide](aws-remote-s3-filter-guide.md)
