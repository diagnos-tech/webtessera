// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// The AWS Signature Version 4 test suite, header-signing cases, as published in
// awslabs/aws-c-auth (tests/aws-signing-test-suite/v4) at commit c4bc791ac6985eedb503e882cd450cc5b344c2f2, transcribed
// verbatim from its request.txt, context.json, header-canonical-request.txt,
// header-string-to-sign.txt and header-signature.txt files. Test data only; not part of the
// published build. NOTICE attributes it.

/** SigV4SuiteCase is one case of the AWS SigV4 test suite. */
export interface SigV4SuiteCase {
	readonly name: string;
	/** request is the raw HTTP request the case signs. */
	readonly request: string;
	readonly context: {
		readonly credentials: {
			readonly access_key_id: string;
			readonly secret_access_key: string;
			readonly token?: string;
		};
		readonly region: string;
		readonly service: string;
		readonly sign_body: boolean;
		readonly timestamp: string;
		readonly normalize: boolean;
		readonly omit_session_token?: boolean;
	};
	readonly canonicalRequest: string;
	readonly stringToSign: string;
	readonly signature: string;
}

export const sigV4Suite: readonly SigV4SuiteCase[] = [
	{
		name: "get-header-key-duplicate",
		request: "GET / HTTP/1.1\nHost:example.amazonaws.com\nMy-Header1:value2\nMy-Header1:value2\nMy-Header1:value1\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value2,value2,value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\ndc7f04a3abfde8d472b0ab1a418b741b7c67174dad1551b4117b15527fbe966c",
		signature: "c9d5ea9f3f72853aea855b47ea873832890dbdd183b4468f858259531a5138ea",
	},
	{
		name: "get-header-value-multiline",
		request: "GET / HTTP/1.1\nHost:example.amazonaws.com\nMy-Header1:value1\n  value2\n     value3\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1 value2 value3\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\ne99419459a677bc11de234014be3c4e72c1ea5b454ceb58b613061f5d7a162e8",
		signature: "cfd34249e4b1c8d6b91ef74165d41a32e5fab3306300901bb65a51a73575eefd",
	},
	{
		name: "get-header-value-order",
		request:
			"GET / HTTP/1.1\nHost:example.amazonaws.com\nMy-Header1:value4\nMy-Header1:value1\nMy-Header1:value3\nMy-Header1:value2\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value4,value1,value3,value2\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n31ce73cd3f3d9f66977ad3dd957dc47af14df92fcd8509f59b349e9137c58b86",
		signature: "08c7e5a9acfcfeb3ab6b2185e75ce8b1deb5e634ec47601a50643f830c755c01",
	},
	{
		name: "get-header-value-trim",
		request: 'GET / HTTP/1.1\nHost:example.amazonaws.com\nMy-Header1: value1\nMy-Header2: "a   b   c"\n',
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			'GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nmy-header2:"a b c"\nx-amz-date:20150830T123600Z\n\nhost;my-header1;my-header2;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\na726db9b0df21c14f559d0a978e563112acb1b9e05476f0a6a1c7d68f28605c7",
		signature: "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
	},
	{
		name: "get-relative-normalized",
		request: "GET /example/.. HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
		signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
	},
	{
		name: "get-relative-relative-normalized",
		request: "GET /example1/example2/../.. HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
		signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
	},
	{
		name: "get-relative-relative-unnormalized",
		request: "GET /example1/example2/../.. HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: false,
		},
		canonicalRequest:
			"GET\n/example1/example2/../..\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n76115030c0f3ff06c20fdff5ceb6d5e0b835a1743e00b94fea7c7f381269437b",
		signature: "dc33e0856fd4baca4d7aa2146c38958283844764f38c74252a333df5e613003b",
	},
	{
		name: "get-relative-unnormalized",
		request: "GET /example/.. HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: false,
		},
		canonicalRequest:
			"GET\n/example/..\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n0511f456aa502b456d135fcb9d749374a55228f9dbeedda1eacf659e05b0615b",
		signature: "eca7ead57bb5aa5c8e28007acd4ff04e1ff9a0ff3b237ec1554a184887ff9282",
	},
	{
		name: "get-slash-dot-slash-normalized",
		request: "GET /./ HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
		signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
	},
	{
		name: "get-slash-dot-slash-unnormalized",
		request: "GET /./ HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: false,
		},
		canonicalRequest:
			"GET\n/./\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nd67825e2268bd77a97c7688b8d72c31a3c1855b309808505ba0a9747d2465aa7",
		signature: "68714168e6557f8f2de0ef956fc24dc2593a4bd2961f8df51898d8a134695145",
	},
	{
		name: "get-slash-normalized",
		request: "GET // HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
		signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
	},
	{
		name: "get-slash-pointless-dot-normalized",
		request: "GET /./example HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/example\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n214d50c111a8edc4819da6a636336472c916b5240f51e9a51b5c3305180cf702",
		signature: "ef75d96142cf21edca26f06005da7988e4f8dc83a165a80865db7089db637ec5",
	},
	{
		name: "get-slash-pointless-dot-unnormalized",
		request: "GET /./example HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: false,
		},
		canonicalRequest:
			"GET\n/./example\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n73895e0e829507e28e39fd24669aedc2434a8e179e547e3c075b42921f952cdb",
		signature: "beb03f223f7deae4146464f06e29eebbee9c8afbe15c290cf07aa8b119e14cff",
	},
	{
		name: "get-slash-unnormalized",
		request: "GET // HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: false,
		},
		canonicalRequest:
			"GET\n//\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n80cb39203d058af815de2b79250ff56e1b73eb9b4718c86556cdc6f150c5d209",
		signature: "c88bcd3d312d75078c0cd961d6deae3f4c754924b01669efcfcb439fd5e5b76e",
	},
	{
		name: "get-slashes-normalized",
		request: "GET //example// HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/example/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\ncb96b4ac96d501f7c5c15bc6d67b3035061cfced4af6585ad927f7e6c985c015",
		signature: "9a624bd73a37c9a373b5312afbebe7a714a789de108f0bdfe846570885f57e84",
	},
	{
		name: "get-slashes-unnormalized",
		request: "GET //example// HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: false,
		},
		canonicalRequest:
			"GET\n//example//\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n528ec3105ee1f34ab014bb0a1a45da0ed2742a4fea3555149e5b4d5d201eb240",
		signature: "87cca117541a147f6df867677d98a7d80dff226d2bfca9e4ffa899665623c7e5",
	},
	{
		name: "get-space-normalized",
		request: "GET /example space/ HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/example%20space/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n63ee75631ed7234ae61b5f736dfc7754cdccfedbff4b5128a915706ee9390d86",
		signature: "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741",
	},
	{
		name: "get-space-unnormalized",
		request: "GET /example space/ HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: false,
		},
		canonicalRequest:
			"GET\n/example%20space/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n63ee75631ed7234ae61b5f736dfc7754cdccfedbff4b5128a915706ee9390d86",
		signature: "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741",
	},
	{
		name: "get-unreserved",
		request:
			"GET /-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n6a968768eefaa713e2a6b16b589a8ea192661f098f37349f4e2c0082757446f9",
		signature: "07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f",
	},
	{
		name: "get-utf8",
		request: "GET /ሴ HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/%E1%88%B4\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n2a0a97d02205e45ce2e994789806b19270cfbbb0921b278ccf58f5249ac42102",
		signature: "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85",
	},
	{
		name: "get-vanilla",
		request: "GET / HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
		signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
	},
	{
		name: "get-vanilla-empty-query-key",
		request: "GET /?Param1=value1 HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\nParam1=value1\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n1e24db194ed7d0eec2de28d7369675a243488e08526e8c1c73571282f7c517ab",
		signature: "a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb",
	},
	{
		name: "get-vanilla-query",
		request: "GET / HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
		signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
	},
	{
		name: "get-vanilla-query-order-encoded",
		request: "GET /?Param-3=Value3&Param=Value2&%E1%88%B4=Value1 HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n%E1%88%B4=Value1&Param=Value2&Param-3=Value3\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n868294f5c38bd141c4972a373a76654f1418a8e4fc18b2e7903ae45e8ae0ec71",
		signature: "371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac",
	},
	{
		name: "get-vanilla-query-order-key-case",
		request: "GET /?Param2=value2&Param1=value1 HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0",
		signature: "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
	},
	{
		name: "get-vanilla-query-unreserved",
		request:
			"GET /?-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nc30d4703d9f799439be92736156d47ccfb2d879ddf56f5befa6d1d6aab979177",
		signature: "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
	},
	{
		name: "get-vanilla-utf8-query",
		request: "GET /?ሴ=bar HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n%E1%88%B4=bar\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\neb30c5bed55734080471a834cc727ae56beb50e5f39d1bff6d0d38cb192a7073",
		signature: "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04",
	},
	{
		name: "get-vanilla-with-session-token",
		request: "GET / HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
				token: "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\nx-amz-security-token:6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267\n\nhost;x-amz-date;x-amz-security-token\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n067b36aa60031588cea4a4cde1f21215227a047690c72247f1d70b32fbbfad2b",
		signature: "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8",
	},
	{
		name: "post-header-key-case",
		request: "POST / HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87",
		signature: "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
	},
	{
		name: "post-header-key-sort",
		request: "POST / HTTP/1.1\nHost:example.amazonaws.com\nMy-Header1:value1\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"POST\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n9368318c2967cf6de74404b30c65a91e8f6253e0a8659d6d5319f1a812f87d65",
		signature: "c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c",
	},
	{
		name: "post-header-value-case",
		request: "POST / HTTP/1.1\nHost:example.amazonaws.com\nMy-Header1:VALUE1\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"POST\n/\n\nhost:example.amazonaws.com\nmy-header1:VALUE1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nd51ced243e649e3de6ef63afbbdcbca03131a21a7103a1583706a64618606a93",
		signature: "cdbc9802e29d2942e5e10b5bccfdd67c5f22c7c4e8ae67b53629efa58b974b7d",
	},
	{
		name: "post-sts-header-after",
		request: "POST / HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
				token:
					"AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
			omit_session_token: true,
		},
		canonicalRequest:
			"POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87",
		signature: "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
	},
	{
		name: "post-sts-header-before",
		request: "POST / HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
				token:
					"AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
			omit_session_token: false,
		},
		canonicalRequest:
			"POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\nx-amz-security-token:AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==\n\nhost;x-amz-date;x-amz-security-token\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nc237e1b440d4c63c32ca95b5b99481081cb7b13c7e40434868e71567c1a882f6",
		signature: "85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead",
	},
	{
		name: "post-vanilla",
		request: "POST / HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87",
		signature: "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
	},
	{
		name: "post-vanilla-empty-query-value",
		request: "POST /?Param1=value1 HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"POST\n/\nParam1=value1\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n9d659678c1756bb3113e2ce898845a0a79dbbc57b740555917687f1b3340fbbd",
		signature: "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11",
	},
	{
		name: "post-vanilla-query",
		request: "POST /?Param1=value1 HTTP/1.1\nHost:example.amazonaws.com\n",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: false,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"POST\n/\nParam1=value1\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n9d659678c1756bb3113e2ce898845a0a79dbbc57b740555917687f1b3340fbbd",
		signature: "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11",
	},
	{
		name: "post-x-www-form-urlencoded",
		request:
			"POST / HTTP/1.1\nContent-Type:application/x-www-form-urlencoded\nHost:example.amazonaws.com\nContent-Length:13\n\nParam1=value1",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: true,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"POST\n/\n\ncontent-length:13\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-content-sha256:9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e\nx-amz-date:20150830T123600Z\n\ncontent-length;content-type;host;x-amz-content-sha256;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nb1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb",
		signature: "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
	},
	{
		name: "post-x-www-form-urlencoded-parameters",
		request:
			"POST / HTTP/1.1\nContent-Type:application/x-www-form-urlencoded; charset=utf-8\nHost:example.amazonaws.com\nContent-Length:13\n\nParam1=value1",
		context: {
			credentials: {
				access_key_id: "AKIDEXAMPLE",
				secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			},
			region: "us-east-1",
			service: "service",
			sign_body: true,
			timestamp: "2015-08-30T12:36:00Z",
			normalize: true,
		},
		canonicalRequest:
			"POST\n/\n\ncontent-length:13\ncontent-type:application/x-www-form-urlencoded; charset=utf-8\nhost:example.amazonaws.com\nx-amz-content-sha256:9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e\nx-amz-date:20150830T123600Z\n\ncontent-length;content-type;host;x-amz-content-sha256;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
		stringToSign:
			"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\na89f1a5b53e37702ee6363ce1da3ce8f54386f3c8f352ae652153c2982a0bc4d",
		signature: "328d1b9eaadca9f5818ef05e8392801e091653bafec24fcab71e7344e7f51422",
	},
];
