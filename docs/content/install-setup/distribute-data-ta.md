# Distribute the Data TA to Heavy Forwarders

When a Deployment Server manages your heavy forwarders, the Data TA reaches them only after the one-time steps on this page: nothing is distributed automatically when you install it. Use this page after you have [installed the Data TA](install-ta.md) on the Deployment Server and made the two index-time decisions. Without a Deployment Server, see [Without a Deployment Server](#without-a-deployment-server) at the end.

<br>

### :material-circle-box:{ .taiconcolor } 0. Before the First Save { #0-before-the-first-save }

The first push carries your Configuration values to every forwarder, and each forwarder restarts when the Data TA arrives. Have these ready:

- **The filter values** ([Decide Filtering](decide-filtering.md)), including, for Azure, whether to drop the Unix command output with Exclude Sources.
- **The Cloud Provider value** ([Choose Cloud Attribution](cloud-attribution.md)): normally **Not set**.
- **What to do about the first-start backlog** ([First Start: The Queue Backlog](../getting-started/capacity-planning.md#first-start-the-queue-backlog)): ask SAP to purge it (on AWS you can load the purged days later with [AWS S3 Direct](aws-s3-direct.md); on Azure and GCP nothing in this solution can load them), or filter it.

<br>

### :material-circle-box:{ .taiconcolor } 1. Make the Heavy Forwarders Deployment Clients { #1-make-the-heavy-forwarders-deployment-clients }

On each heavy forwarder that will run a LogServ input, point it at the Deployment Server and restart it:

```bash
$SPLUNK_HOME/bin/splunk set deploy-poll <deployment-server>:8089
$SPLUNK_HOME/bin/splunk restart
```

Or put the same in `$SPLUNK_HOME/etc/system/local/deploymentclient.conf`:

```ini
[deployment-client]

[target-broker:deploymentServer]
targetUri = <deployment-server>:8089
```

Then check on the Deployment Server, in **Settings → Forwarder Management** (named **Agent Management** in newer Splunk Enterprise versions), that each forwarder is listed. Do this first: the Data TA recognises a Deployment Server by a server class it already has or by forwarders that phone home to it, and a Save on an instance it does not recognise as one does none of the steps below. To check from the Deployment Server's command line:

```bash
curl -sk -u <admin_user> \
  "https://localhost:8089/services/deployment/server/clients?output_mode=json&count=1"
```

An empty `entry` list means no forwarder has phoned home yet.

Keep the Splunk Add-on for AWS and the LogServ Azure and GCP add-ons out of the LogServ server class: they are installed on each forwarder directly, and a push replaces an app's `local/` folder, where their credentials and inputs live.

<br>

### :material-circle-box:{ .taiconcolor } 2. Save the Configuration Page on the Deployment Server { #2-save-the-configuration-page-on-the-deployment-server }

On the Deployment Server, open the **Splunk TA for SAP LogServ** app, go to **Configuration**, enter your values on the **Filters** tab (or leave Enable Filtering unchecked) and click **Save**. Save the **Cloud Provider** tab too if you set it to anything other than **Not set**. Save even if you do not want filtering: the first Save is what prepares the distribution.

On a Deployment Server, a Save on either tab:

1. Copies the whole Data TA from `etc/apps/splunk_ta_sap_logserv/` to `etc/deployment-apps/splunk_ta_sap_logserv/`, its `local/` folder included, if that copy does not exist yet or its version (`[launcher] version` in `default/app.conf`) differs. Otherwise it copies nothing; see [Later Builds With the Same Version](#later-builds-with-the-same-version).
2. Creates the server class `SAP_LogServ_HeavyForwarders`, if it does not exist: **disabled**, with no forwarders assigned, and with the Data TA mapped to it with `restartSplunkd = true`, so each forwarder restarts when it receives the app.
3. Copies the generated `local/transforms.conf` and `local/props.conf` (the filter rules and the Cloud Provider stamp) into the `deployment-apps` copy.

After the Save, the Filters tab shows a **Deployment Server Detected** banner, a **Server Class Setup Required** notice while the server class is disabled (or **Client Targeting Needed** if the class is enabled but has no forwarders assigned) and a **Deploy to Forwarders** button.

??? note "Example"
    ![image](../../images/filter-ds-detected-banner.png "Deployment Server Detected Banner")

The button, and the check that decides whether to show it, need the `edit_deployment_server` capability. Splunk Enterprise's `admin` role has it; a custom Deployment Server operator role needs it added, or the button does not appear.

<br>

### :material-circle-box:{ .taiconcolor } 3. Assign the Heavy Forwarders to the Server Class { #3-assign-the-heavy-forwarders-to-the-server-class }

1. Go to **Settings → Forwarder Management** (or **Agent Management**), **Groups / Server Classes**.
2. Find the `SAP_LogServ_HeavyForwarders` server class.
3. Click the three-dot menu → **Edit agent assignment**.
4. Under **Include**, enter your heavy forwarders' IP addresses or host names, separated by commas. Click **Preview** and check that exactly your LogServ forwarders match.
5. Click **Save**.

!!! warning "Never use `*` here"
    `*` assigns the class to every deployment client of this Deployment Server, search heads and unrelated forwarders included. Each of them would receive the Data TA and restart (`restartSplunkd = true`). Name the heavy forwarders.

??? note "Example"
    ![image](../../images/filter-forwarder-mgmt.png "Forwarder Management Server Class")

??? tip "Client Targeting"
    Splunk matches each entry against the forwarder's IP address, host name, DNS name, client name or GUID (instance ID), not against the **Instance Name** column. IP addresses are the simplest to get right.

In the lab, saving the assignment also enabled the server class. Return to the Filters tab and refresh the page: the setup notice should be gone. If it still says the class is disabled, enable the class in Forwarder Management. If it shows **Client Targeting Needed**, the class has no agent assignment yet: repeat this step.

??? note "Example"
    ![image](../../images/filter-setup-notice-gone.png "Filters After Agent Assignment")

<br>

### :material-circle-box:{ .taiconcolor } 4. Deploy to Forwarders { #4-deploy-to-forwarders }

1. On the Filters tab, click **Deploy to Forwarders** and confirm. The banner confirms that the deployment reload has started.

    ??? note "Example"
        ![image](../../images/filter-deploy-initiated.png "Deploy Reload Initiated")

2. Each forwarder picks up the Data TA at its next phone-home (`phoneHomeIntervalInSecs` in `deploymentclient.conf`, 60 seconds by default) and then restarts.
3. Check **Settings → Forwarder Management**: the forwarders should show **Ok** under the server class. Allow 5 minutes or more for the status to change from `Pending` to `Ok`.

??? note "Example"
    ![image](../../images/filter-deploy-success.png "Deploy Success")

!!! note "Deploy to Forwarders reloads the whole Deployment Server"
    The button reloads every server class on this Deployment Server, not only `SAP_LogServ_HeavyForwarders`: if another server class has changes waiting, its clients receive them at their next phone-home too. (Saving an edit in Forwarder Management also reloads the Deployment Server, so the forwarders may start receiving the Data TA as soon as you save the assignment in step 3.) The Data TA's own daily filter refresh reloads only its own server class.

<br>

### :material-circle-box:{ .taiconcolor } 5. Check the Build on Each Heavy Forwarder { #5-check-the-build-on-each-heavy-forwarder }

On each heavy forwarder, check that it runs the Data TA build you installed on the Deployment Server: see [Version Check](../getting-started/capacity-planning.md#version-check). **Create no input before every forwarder shows the build.** Events a forwarder indexes before it has the Data TA keep the base `sap_logserv_logs` sourcetype and are neither routed nor filtered, permanently.

To see which filter a forwarder applies, read its `local/transforms.conf`, not its `filter_settings` REST endpoint, which can show older settings ([Reading the Active Filter Configuration](configure-filters.md#reading-the-active-filter-configuration)).

<br>

### :material-circle-box:{ .taiconcolor } Later Builds With the Same Version { #later-builds-with-the-same-version }

The Save copies the whole Data TA into `deployment-apps/` only the first time and when the version changes. Every 0.1.2 build has the version `0.1.2`, so a newer 0.1.2 build that you install in `etc/apps/` on the Deployment Server is **not** copied, and the forwarders keep the older build. Install the new build into `etc/deployment-apps/splunk_ta_sap_logserv/` as well, keeping its `local/` folder, then click **Deploy to Forwarders**. The commands are in [Upgrading to This Release → Updating the Data TA](../getting-started/upgrading.md#data-ta-splunk_ta_sap_logserv-routine-upgrade).

While Enable Filtering is checked and Days in the Past is above 0, the Data TA's daily filter refresh makes the same version-change copy (it also runs when splunkd starts) and then reloads the `SAP_LogServ_HeavyForwarders` server class. After a version upgrade on the Deployment Server, the forwarders can therefore receive the new version and restart without a Save or **Deploy to Forwarders**. Plan the upgrade for that.

A copy made because the version changed, by a Save or by the daily filter refresh, replaces the whole `deployment-apps` copy, including anything you added by hand under `etc/deployment-apps/splunk_ta_sap_logserv/local/`, with a copy of `etc/apps/splunk_ta_sap_logserv/`. Keep hand edits in `etc/apps/splunk_ta_sap_logserv/local/` too.

<br>

### :material-circle-box:{ .taiconcolor } Changing Settings Later { #changing-settings-later }

Change the Filters or Cloud Provider tab on the Deployment Server, click **Save**, then **Deploy to Forwarders**: see [Updating Filters on a Deployment Server](configure-filters.md#updating-filters-on-a-deployment-server). A change applies to events parsed after the forwarders receive it.

While filtering is on and Days in the Past is above 0, the Data TA's daily refresh pushes a new time cutoff by itself, and each forwarder in the server class restarts about once a day ([Days in the Past](configure-filters.md#days-in-the-past)).

<br>

### :material-circle-box:{ .taiconcolor } Without a Deployment Server { #without-a-deployment-server }

A Deployment Server is optional, Splunk Cloud included: Splunk Cloud is never a Deployment Server (the **Deploy to Forwarders** button never appears there), and your Splunk Cloud subscription includes a deployment server license for one you run yourself (you request it from Splunk Support).

Without one:

1. Install the Data TA directly on each heavy forwarder that runs a LogServ input ([Install the Data TA](install-ta.md)).
2. On each forwarder, enter your values on **Configuration → Filters** (and **Cloud Provider**, if you set it) and click **Save**. The Save writes the rules on that forwarder and applies them at once, with no restart; no **Deploy to Forwarders** button appears.
3. With several forwarders, enter the same values on each one: nothing copies them between forwarders.
4. Check the build on each forwarder ([Version Check](../getting-started/capacity-planning.md#version-check)).

Do not install the Data TA directly on a forwarder that a Deployment Server also pushes it to: the push replaces the forwarder's copy, its `local/` settings included. A forwarder that a Deployment Server manages for other apps only can hold the Data TA directly; see [Heavy Forwarder without a Deployment Server](configure-filters.md#heavy-forwarder-without-a-deployment-server) for how its daily refresh behaves.

<br>

## :material-circle-box:{ .cboxmove } Next Steps

1. [Choose Your Cloud and AWS Scenario](choose-your-cloud.md), then follow the setup guide for your cloud to create the inputs.
2. [Verify Your Data](../getting-started/verify-data.md) once events arrive.
