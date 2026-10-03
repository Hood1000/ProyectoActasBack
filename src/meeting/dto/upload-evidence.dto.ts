import { IsNotEmpty, IsString } from 'class-validator';

export class UploadEvidenceDto {
  @IsString()
  @IsNotEmpty()
  evidenceSignaturesUrl: string;
}
