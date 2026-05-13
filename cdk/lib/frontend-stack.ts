import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  projectName: string;
  stage: string;
}

/**
 * Frontend delivery: separate CloudFront distros per app.
 *
 * Why multiple distros (not 1 with multiple behaviors):
 *   1. Each app has different cache TTLs and headers (admin needs no cache;
 *      landing wants aggressive cache)
 *   2. Independent invalidation — fixing landing doesn't invalidate dashboards
 *   3. Per-app WAF rules (admin can have stricter origin headers)
 *   4. Per-app cost attribution and CDN invalidation budget tracking
 */
export class FrontendStack extends cdk.Stack {
  public readonly userDashboardBucket: s3.Bucket;
  public readonly adminBucket: s3.Bucket;
  public readonly landingBucket: s3.Bucket;
  public readonly publicAssetsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { projectName, stage } = props;

    const buildSpaDistribution = (
      bucket: s3.Bucket,
      label: string,
      cachePolicy: cloudfront.ICachePolicy,
    ): cloudfront.Distribution => {
      const oai = new cloudfront.OriginAccessIdentity(this, `${label}Oai`);
      bucket.grantRead(oai);

      return new cloudfront.Distribution(this, `${label}Distro`, {
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: new origins.S3Origin(bucket, { originAccessIdentity: oai }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy,
          compress: true,
        },
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US/EU only — saves ~30%
        errorResponses: [
          // SPA fallback — every 4xx returns index.html so client router takes over
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.minutes(5),
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.minutes(5),
          },
        ],
        httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      });
    };

    // ─── Buckets ──────────────────────────────────────────────────────────────
    const bucketProps: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    };

    this.userDashboardBucket = new s3.Bucket(this, 'UserDashboardBucket', {
      ...bucketProps,
      bucketName: `${projectName}-${stage}-user-dashboard`,
    });
    this.adminBucket = new s3.Bucket(this, 'AdminBucket', {
      ...bucketProps,
      bucketName: `${projectName}-${stage}-admin`,
    });
    this.landingBucket = new s3.Bucket(this, 'LandingBucket', {
      ...bucketProps,
      bucketName: `${projectName}-${stage}-landing`,
    });
    this.publicAssetsBucket = new s3.Bucket(this, 'PublicAssetsBucket', {
      ...bucketProps,
      bucketName: `${projectName}-${stage}-public-assets`,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
    });

    // ─── Distributions ────────────────────────────────────────────────────────
    // Aggressive cache for landing — content rarely changes; every cached hit
    // is a CloudFront request that doesn't reach S3.
    const aggressive = new cloudfront.CachePolicy(this, 'AggressiveCache', {
      cachePolicyName: `${projectName}-aggressive`,
      defaultTtl: cdk.Duration.days(1),
      maxTtl: cdk.Duration.days(30),
      minTtl: cdk.Duration.minutes(5),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    // No-cache for admin — stale UI is dangerous in admin operations
    const noCache = cloudfront.CachePolicy.CACHING_DISABLED;

    buildSpaDistribution(this.userDashboardBucket, 'UserDashboard', cloudfront.CachePolicy.CACHING_OPTIMIZED);
    buildSpaDistribution(this.adminBucket, 'Admin', noCache);
    buildSpaDistribution(this.landingBucket, 'Landing', aggressive);

    // Public assets — separate distro because a bug or compromise here
    // doesn't affect authenticated app traffic.
    new cloudfront.Distribution(this, 'PublicAssetsDistro', {
      defaultBehavior: {
        origin: new origins.S3Origin(this.publicAssetsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: aggressive,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new cdk.CfnOutput(this, 'UserDashboardBucketName', { value: this.userDashboardBucket.bucketName });
    new cdk.CfnOutput(this, 'AdminBucketName', { value: this.adminBucket.bucketName });
  }
}
