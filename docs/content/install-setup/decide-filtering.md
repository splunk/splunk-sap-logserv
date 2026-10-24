# Decide Filtering

This page helps you decide whether the Data TA should filter LogServ data, and with which values, before you distribute it. It is a decision page: [Configuring Filters](configure-filters.md) is the reference for every field and rule.

Decide before the first **Save** on the Deployment Server's Configuration page, and at the latest before any input starts. The Data TA's filters run at index time, on the heavy forwarders or the single instance: anything indexed before you decide stays as it was indexed. With a Deployment Server, the first push carries your choice to the forwarders, and each forwarder restarts once when the Data TA arrives.

Write your values down as you go ([Your Values](#your-values) at the end), then enter them on **Configuration → Filters** in the next step.

<br>

### :material-circle-box:{ .taiconcolor } 1. Turn Filtering On, or Leave It Off { #1-turn-filtering-on-or-leave-it-off }

**Enable Filtering** is off by default: every LogServ event is indexed, and the other fields on the Filters tab have no effect until you check it.

- **Leave it off** if you want all the data SAP delivers, or want to decide later for new data only.
- **Turn it on** to drop folders, files or old events before they are indexed. Dropped events use no license and no index space; the forwarder still downloads and parses them ([Configuring Filters](configure-filters.md#native-ta-index-time-filtering)).

!!! warning "With a Deployment Server, filtering on means a restart a day"
    While Enable Filtering is checked and Days in the Past is above 0, the Data TA's daily refresh moves the time cutoff, the Deployment Server pushes the new rules, and **each heavy forwarder in the server class restarts about once a day** to apply them. With Days in the Past at 0 the refresh changes nothing and no daily restart follows, so you can filter by folder or file without it. See [Days in the Past](configure-filters.md#days-in-the-past).

<br>

### :material-circle-box:{ .taiconcolor } 2. Days in the Past { #2-days-in-the-past }

Days in the Past drops events whose own `_time` is older than midnight UTC that many days ago. It applies only while Enable Filtering is checked.

- **Default 7.** Set `0` (or leave the field empty) to keep events of any age. The range is 0 to 3650.
- **The first-start backlog.** A new input can start with days or weeks of notifications waiting in SAP's queue ([First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog)). Days in the Past drops the older events of that backlog at index time; the forwarder still downloads and parses them, so it does not make the catch-up shorter.
- **Loading history later.** On AWS, history is loaded with [AWS S3 Direct](aws-s3-direct.md). With filtering on, that screen leaves out every day older than the cutoff, because their events would be dropped on arrival. Before a history load, raise Days in the Past to cover the oldest day you will load, or set it to 0.

<br>

### :material-circle-box:{ .taiconcolor } 3. Azure: the Unix Command Output { #3-azure-the-unix-command-output }

On Azure, SAP files some data in a storage folder named `undefined/undefined`, and its events carry no `clz_dir` or `clz_subdir`. Almost all of it is the output of Unix commands (`source` values such as `ps`, `netstat`, `iostat`, `top`): about **0.7 million events and 125 MB of text a day** on the reference system, about 80% of it `ps`. It stays under the base `sap_logserv_logs` sourcetype, and the LogServ App does not parse it; it only counts it in its volume dashboards. See [Data Delivered Without Folder Fields](../getting-started/supported-log-types.md#data-delivered-without-folder-fields).

- **To drop it**, which we recommend unless you use it: turn filtering on and set Exclude Sources to `ps, top, netstat, iostat, vmstat, df, cpu, interfaces, bandwidth, openPorts, nfsiostat, Unix:ListeningPorts`. Folder patterns cannot reach these events, so Exclude Filters cannot drop them. If you turn filtering on only for this, also set Days in the Past to 0: with the default 7, older events are dropped too and, with a Deployment Server, each forwarder restarts about once a day (see [1](#1-turn-filtering-on-or-leave-it-off) and [2](#2-days-in-the-past)).
- **If you keep it**, restrict who can search it: a `ps` row can carry the arguments a process was started with, and arguments can contain passwords, keys or tokens.
- **An Include Filters allow-list drops it too**, together with the HANA trace files that arrive in the same folder without folder fields, unless an Include Sources entry keeps them ([Events Without Folder Fields](configure-filters.md#events-without-folder-fields)).

<br>

### :material-circle-box:{ .taiconcolor } 4. Which Folders and Files to Keep { #4-which-folders-and-files-to-keep }

With Include Filters at `*/*` (the default) every folder is kept, and you drop what you do not want with Exclude Filters (folders) and Exclude Sources (files). With an allow-list in Include Filters, only the folders you list are kept. [Filter Recipes](configure-filters.md#filter-recipes) has ready-made settings for both, and [How the Rules Combine](configure-filters.md#how-the-rules-combine) gives the order the rules run in.

<br>

### :material-circle-box:{ .taiconcolor } 5. AWS Remote S3 Filter: the Lambda Is a Separate Filter { #5-aws-remote-s3-filter-the-lambda-is-a-separate-filter }

If you use the AWS Remote S3 Filter scenario, its Lambda filters notifications in AWS before the forwarder sees them, with settings of its own that you enter in the CloudFormation template. It is not the Filters tab and behaves differently: it reads every object, its time cutoff is a rolling now minus N days, `*` in its patterns also matches across `/`, an empty include list drops everything, and it drops notifications it cannot process. See [AWS Lambda-Based Filtering](configure-filters.md#aws-lambda-based-filtering) and the [AWS Remote S3 Filter Setup Guide](aws-remote-s3-filter-guide.md).

<br>

### :material-circle-box:{ .taiconcolor } Your Values { #your-values }

| Field on Configuration → Filters | Default | Your value |
|---|---|---|
| Enable Filtering | unchecked | |
| Include Filters | `*/*` | |
| Exclude Filters | empty | |
| Include Sources | empty | |
| Exclude Sources | empty (on Azure, consider the twelve Unix command names above) | |
| Days in the Past | `7` (applies only with filtering on) | |

You can change them later; a change applies to events parsed after the forwarders receive it ([Updating Filters on a Deployment Server](configure-filters.md#updating-filters-on-a-deployment-server)).

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. [First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog): decide how to handle the notifications already waiting in SAP's queue. Your choice can change Days in the Past.
2. [Distribute the Data TA to Heavy Forwarders](distribute-data-ta.md): enter these values there in step 2. On a single instance, or a heavy forwarder without a Deployment Server, enter them on **Configuration → Filters** and click **Save**.
3. Then [Choose Your Cloud and AWS Scenario](choose-your-cloud.md) to connect your cloud.
