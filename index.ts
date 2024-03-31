import "dotenv/config";

import {
  CloudFormationClient,
  DescribeStacksCommand,
  StackStatus,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
  waitUntilStackUpdateComplete,
} from "@aws-sdk/client-cloudformation";
import type { WaiterConfiguration, WaiterResult } from "@smithy/util-waiter";
import { App, Stack, StackProps } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  AmazonLinuxCpuType,
  AmazonLinuxGeneration,
  AmazonLinuxImage,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { CnameRecord, HostedZone } from "aws-cdk-lib/aws-route53";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";

/**
 * Wait for existing CloudFormation stack to be in an idle state.
 */
async function waitForStackIdle(
  stackName: string,
  cloudFormationClient: CloudFormationClient = new CloudFormationClient({}),
): Promise<WaiterResult | void> {
  const stackCommand = new DescribeStacksCommand({ StackName: stackName });

  try {
    const stackInfo = await cloudFormationClient.send(stackCommand);

    const stackStatus = stackInfo.Stacks?.[0]?.StackStatus;

    if (!stackStatus) {
      return;
    }

    const params: WaiterConfiguration<CloudFormationClient> = {
      client: cloudFormationClient,
      maxWaitTime: 1800,
    };

    switch (stackStatus) {
      case StackStatus.CREATE_IN_PROGRESS:
        return await waitUntilStackCreateComplete(params, { StackName: stackName });

      case StackStatus.UPDATE_IN_PROGRESS:
        return await waitUntilStackUpdateComplete(params, { StackName: stackName });

      case StackStatus.DELETE_IN_PROGRESS:
        return await waitUntilStackDeleteComplete(params, { StackName: stackName });

      default:
        return;
    }
  } catch {
    return;
  }
}

class KnowledgeBaseStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    if (!process.env.CERTIFICATE_ARN) {
      throw new Error("Certificate ARN not defined. Stop.");
    }
    if (!process.env.GOOGLE_APP_ID) {
      throw new Error("Google App ID not defined. Stop.");
    }
    if (!process.env.GOOGLE_APP_SECRET) {
      throw new Error("Google App Secret not defined. Stop.");
    }

    super(scope, id, props);
    const certificateArn: string = process.env.CERTIFICATE_ARN;
    const googleAppId: string = process.env.GOOGLE_APP_ID;
    const googleAppSecret: string = process.env.GOOGLE_APP_SECRET;

    const recordName = "kb";
    const domainName = "icssc.club";
    const appUrl = `${recordName}.${domainName}`;

    const vpc = new Vpc(this, `${id}-vpc`, {
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: `${id}-subnet-configuration`,
          subnetType: SubnetType.PUBLIC,
        },
      ],
    });

    const securityGroup = new SecurityGroup(this, `${id}-security-group`, {
      vpc,
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22));
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80));

    const instance = new Instance(this, `${id}-instance`, {
      vpc,
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      machineImage: new AmazonLinuxImage({
        generation: AmazonLinuxGeneration.AMAZON_LINUX_2023,
        cpuType: AmazonLinuxCpuType.ARM_64,
      }),
      associatePublicIpAddress: true,
      securityGroup,
    });

    const setupScript = new Asset(this, `${id}-setup-script`, {
      path: "./bookstack-setup-al2023.sh",
    });
    setupScript.grantRead(instance.role);

    const filePath = instance.userData.addS3DownloadCommand({
      bucket: setupScript.bucket,
      bucketKey: setupScript.s3ObjectKey,
    });

    instance.userData.addExecuteFileCommand({
      filePath,
      arguments: `-a https://${appUrl} -i ${googleAppId} -s ${googleAppSecret}`,
    });

    const distribution = new Distribution(this, `${id}-distribution`, {
      defaultBehavior: {
        origin: new HttpOrigin(instance.instancePublicDnsName, {
          protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
        }),
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
      },
      certificate: Certificate.fromCertificateArn(this, `${id}-certificate`, certificateArn),
      domainNames: [appUrl],
      priceClass: PriceClass.PRICE_CLASS_100,
    });

    new CnameRecord(this, `${id}-cname`, {
      recordName,
      zone: HostedZone.fromLookup(this, `${id}-hosted-zone`, {
        domainName,
      }),
      domainName: distribution.distributionDomainName,
    });
  }
}

async function main() {
  if (!process.env.ACCOUNT_ID) {
    throw new Error("Account ID not defined. Stop.");
  }

  const account = process.env.ACCOUNT_ID;

  const stackName = "icssc-knowledge-base";

  await waitForStackIdle(stackName);

  const app = new App({ autoSynth: true });

  new KnowledgeBaseStack(app, stackName, {
    stackName,
    env: { account, region: "us-east-1" },
  });
}

main().then();
