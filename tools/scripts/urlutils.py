import json
import requests


class UrlUtil:
    def __init__(self, url):
        self.url = url

    def get(self, url=None, headers=None):
        path = url or self.url
        response = requests.request('GET', url=path, headers=headers)
        try:
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            print(e)
            exit(1)
        return response

    def download(self, path=None, output_file=None, headers=None):
        path = path or self.url
        response = requests.get(path, headers=headers, allow_redirects=True)
        try:
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            print(e)
            exit(1)
        open(output_file, 'wb').write(response.content)
        return response
