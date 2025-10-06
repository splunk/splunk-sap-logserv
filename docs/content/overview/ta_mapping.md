# Add-on Sourcetype mapping

### :material-circle-box:{ .taiconcolor } Overview

SAP RISE environment logs are not a singular data source but, in fact, a collection of OS-specific, SAP environment, database, and other applications logs.

Due to the nature of this solution, the Splunk Technical Add-on for SAP Logserv is not a standalone integration. To take full advantage of its capabilities (like CIM mapping), you need to install additional TAs as specified in the [Installation and Setup Prerequisites](../install-setup/prerequisites.md)

For a streamlined data ingestion process, all selected logs are ingested under one sourcetype: `sap_logserv_logs`. They are then assigned to a final sourcetype during parsing/indexing either on a Splunk Heavy Forwarder or directly at the Splunk Indexer, based on the `source` field.

All events are in JSON format with metadata (like _time, host, source, etc.) and the _raw field containing the event contents. 
To limit index size, only the _raw field is ingested from each event - metadata fields are either mapped to Splunk's native metadata fields or dropped. 
However `clz_dir` and `clz_subdir` fields are preserved, to maintain backtracking capabilities. These fields correspond to the directory tree of the original data.




## :material-circle-box:{ .taiconcolor } Sourcetype mapping

<a href="https://splunkbase.splunk.com/app/833" target="_blank">Splunk Add-on for Unix and Linux</a> 

| Source field value         | Sourcetype assigned     |
|----------------------------|-------------------------|
| 	/lastlog	                 | 	lastlog	               |
| 	/var/log/cron	            | 	syslog	                |
| 	/var/log/firewall	        | 	linux_secure	          |
| 	/var/log/kernel	          | 	linux_secure	          |
| 	/var/log/localmessages	   | 	linux_messages_syslog	 |
| 	/var/log/messages	        | 	linux_messages_syslog	 |
| 	/var/log/pacemaker(.log)	 | 	syslog	                |
| 	/var/log/slapd.log	       | 	syslog	                |
| 	/var/log/sssd(.log)	      | 	linux_secure	          |
| 	/var/log/sudolog	         | 	syslog	                |
| 	/var/log/warn	            | 	syslog	                |
| 	/who	                     | 	who	                   |


<a href="https://splunkbase.splunk.com/app/742" target="_blank"> Splunk Add-on for Microsoft Windows</a>

| Source field value         | Sourcetype assigned |
|----------------------------|---------------------|
| 	WinEventLog:Application	  | 	XmlWinEventLog	    |
| 	WinEventLog:(*.)Operational	 | 	XmlWinEventLog	    |
| 	WinEventLog:Security	     | 	XmlWinEventLog	    |
| 	WinEventLog:System	       | 	XmlWinEventLog	    |

<a href="https://splunkbase.splunk.com/app/2965" target="_blank">Splunk Add-on for Squid Proxy</a> 

| Source field value          | Sourcetype assigned     |
|-----------------------------|-------------------------|
| 	/var/log/squid/access.log	 |	squid:access	|
| 	/var/log/squid/cache.log	  |	squid:access	|
| 	/var/log/squid/store.log	  |	squid:access	|


<a href="https://splunkbase.splunk.com/app/2876" target="_blank">Splunk Add-on for ISC BIND</a> 

| Source field value                           | Sourcetype assigned     |
|----------------------------------------------|-------------------------|
| 	/var/lib/named/log/named/default.log	       |	isc:bind:query	|
| 	/var/lib/named/log/named/general.log	       |	isc:bind:network	|
| 	/var/lib/named/log/named/lame-servers.log 	 |	isc:bind:lameserver	|
| 	/var/lib/named/log/named/network.log	       |	isc:bind:network	|
| 	/var/lib/named/log/named/notify.log	        |	isc:bind:transfer	|
| 	/var/lib/named/log/named/queries.log	       |	isc:bind:query	|
| 	/var/lib/named/log/named/resolver.log	      |	isc:bind:network	|
| 	/var/lib/named/log/named/update.log	        |	isc:bind:transfer	|
| 	/var/lib/named/log/named/xfer-out.log	      |	isc:bind:transfer	|




