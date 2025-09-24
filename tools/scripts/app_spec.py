from ast import arg, parse
from urlutils import UrlUtil
import json
import requests
from requests.auth import HTTPBasicAuth
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
import os
import time
import logging
import copy
import argparse

LOGGER = logging.getLogger(__name__)

class AppSecApi(UrlUtil):
    def __init__(self, user, password, app_target, included_tags, allowed_failures):
    # def __init__(self, user, password, app_target, allowed_failures):
        self.base_url = 'https://appinspect.splunk.com/v1/app'
        self.headers = {
            'Cache-Control': 'no-cache',
            'max-messages': '100'
        }
        self.user = user
        # base64 encoded passwords do not seem to work with the login endpoint
        self.password = password
        self.app_target = app_target
        self.auth_url = "https://api.splunk.com/2.0/rest/login/splunk"
        self.request_id = None
        self.included_tags = included_tags
        self.response = None
        self.allowed_failures = allowed_failures
        self.all_errors = ''

    @staticmethod
    def customized_retry_session(
            retries=3,
            backoff_factor=0.5,
            status_force_list=(requests.codes.internal_server_error,),
            session=None):
        """
        customized requests.Session() wrapper
        :param retries: max retry time
        :param backoff_factor: sleep {backoff_factor} * (2 ^ ({number of finished retries} - 1)) seconds
        :param status_force_list: response status codes to trigger retry
        :param session: original requests.Session() instance
        :return: customized requests.Session() instance
        """
        session = session or requests.Session()
        retry = Retry(
            total=retries,
            read=retries,
            connect=retries,
            backoff_factor=backoff_factor,
            status_forcelist=status_force_list,
        )
        adapter = HTTPAdapter(max_retries=retry)
        session.mount('http://', adapter)
        session.mount('https://', adapter)
        return session

    def set_token(self):
        response = requests.get(url=self.auth_url, auth=HTTPBasicAuth(username=self.user, password=self.password))
        if response.status_code == requests.codes.ok:
            json_response = json.loads(response.text)
            self.token = json_response['data']['token']
            self.headers['Authorization'] = f"bearer {self.token}"
        else:
            message = f"Received status code: {response.status_code} from {self.auth_url}"
            LOGGER.exception(message)

    def post_app(self):
        request_session = self.customized_retry_session()
        try:
            FILE = os.path.join(os.path.abspath(os.path.dirname(__file__)), self.app_target)
            response = request_session.post(
                url=f'{self.base_url}/validate',
                headers=copy.deepcopy(self.headers),
                # files={'app_package': open(FILE, 'rb')})  # noqa: X714
                files={'app_package': open(FILE, 'rb'), 'included_tags': (None, self.included_tags)})  # noqa: X714
            return response.json(), response.status_code
        except requests.exceptions.RequestException:
            return "get_submit_app_validate_response_content_failed", requests.codes.internal_server_error


    def submit_cloud_only(self, file, headers, file_path):
        validate_url = self.url+"validate"
        payload = {'included_tags': 'cloud'}
        files = [
            ('app_package', (file, open(file_path, 'rb'),
                             'application/octet-stream'))
        ]
        # submit_response = requests.request("POST", validate_url, headers=headers, files=files)
        submit_response = requests.request("POST", validate_url, headers=headers, data=payload, files=files)
        return submit_response.json()

    def set_request_id(self):
        response_object, status_code = self.post_app()
        if status_code == requests.codes.ok:
            self.request_id = response_object.get('request_id', 'N/A')
            print(self.request_id)

    def poll_report_status(self):
        """
        :param request_id: from submit_apps: appinspect-api request_id
        :param retry_time: total retry time
        :param retry_interval: seconds
        :return: is_valid_report_generated
        """
        retry_time = 12
        backoff_factor = 2
        for i in range(retry_time):
            response_object, status_code = self.get_report_status()
            print(self.get_report_status())
            if response_object.get('status') == 'SUCCESS':
                response_failure_count = response_object.get("info").get("failure")
                if int(str(response_failure_count)) > int(str(self.allowed_failures)):
                    self.all_errors = self.all_errors + "\n* scan_threshold_count::FAILURE More than the usual number of appinspect errors seen. Failures threshold is at " + str(self.allowed_failures) + ", current failures: " + str(response_failure_count)
                    return self.all_errors, requests.codes.internal_server_error
                return response_object, status_code
            time.sleep(backoff_factor * pow(2, i))
        return "fetch_report_status_failed", requests.codes.internal_server_error

    def get_report_status(self):
        """
        :param request_id:
        :return: response_object + status_code
        """
        try:
            request_session = self.customized_retry_session()
            response = request_session.get(
                url=f'{self.base_url}/validate/status/{self.request_id}',
                headers=copy.deepcopy(self.headers))
            return response.json(), response.status_code
        except requests.exceptions.RequestException:
            return "fetch_report_status_failed", requests.codes.internal_server_error

    def fetch_report(self):
        """
        :param request_id:
        :return: response_object + status_code
        """
        headers = copy.deepcopy(self.headers)
        headers['Content-Type'] = 'text/html'
        try:
            request_session = self.customized_retry_session()
            response = request_session.get(
                url=f'{self.base_url}/report/{self.request_id}',
                headers=headers)
            # write-binary usage intentional here
            with open('appinspect_report.html', 'wb') as f:  # noqa: X714
                f.write(response.content)

            print(response)
        except requests.exceptions.RequestException:
            return "fetch_report_object_failed", requests.codes.internal_server_error

    def raise_errors(self):
        if len(self.all_errors) > 0:
            print('Errors found in appinspect validation.')
            raise ValueError(self.all_errors)
        print('Successful appinspect validation. No errors caught.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="appinspect check args")

    parser.add_argument('--username', type=str, help='Splunk username like: abc@splunk.com')
    parser.add_argument('--password', type=str, help='Splunk AD password')
    parser.add_argument('--package_name', type=str, help='package name for appinspect package, expects the file to be present in the current dir, eg: splunk_app_es-6.6.0-0.spl')
    parser.add_argument('--included_tags', type=str, help='Validate an app using tags')
    parser.add_argument('--allowed_failures', type=str, help='Validate an app against allowed_failures')

    args = parser.parse_args()

    # appinspect = AppSecApi(args.username, args.password, args.package_name, args.allowed_failures)
    appinspect = AppSecApi(args.username, args.password, args.package_name, args.included_tags, args.allowed_failures)

    appinspect.set_token()
    appinspect.set_request_id()
    appinspect.poll_report_status()
    appinspect.fetch_report()
    appinspect.raise_errors()
